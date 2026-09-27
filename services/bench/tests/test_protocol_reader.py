"""Exercise the production reader thread with local pipes, never Codex or a model."""
import io
import json
import queue
import threading
import time

import pytest

from ohmpath.ai.live_proof import ProofFailure, Protocol


class Pipe:
    def __init__(self):
        self.lines = queue.Queue()

    def feed(self, *lines):
        for line in lines:
            self.lines.put(line)

    def readline(self, limit):
        line = self.lines.get(timeout=3)
        if isinstance(line, Exception):
            raise line
        return line[:limit]


class Input(io.StringIO):
    def __init__(self, process):
        super().__init__()
        self.process = process

    def flush(self):
        super().flush()
        if self.process.on_send:
            self.process.on_send(json.loads(self.getvalue().splitlines()[-1]))


class Process:
    def __init__(self):
        self.stdout = Pipe()
        self.stdin = Input(self)
        self.on_send = None
        self.stopped = False

    def poll(self):
        return 0 if self.stopped else None

    def terminate(self):
        self.stopped = True
        self.stdout.feed('')

    def kill(self):
        self.terminate()

    def wait(self, timeout):
        return 0


@pytest.fixture
def protocol(monkeypatch):
    process = Process()
    monkeypatch.setattr('ohmpath.ai.live_proof.subprocess.Popen', lambda *args, **kwargs: process)
    instance = Protocol(['synthetic-reader-only'], {})
    try:
        yield instance, process
    finally:
        instance.close()


def encoded(value):
    return json.dumps(value) + '\n'


@pytest.mark.parametrize('consumer', ['request', 'notification'])
@pytest.mark.parametrize('line,code', [
    ('', 'app_server_closed'),
    ('{invalid json}\n', 'invalid_app_server_event'),
    ('[]\n', 'invalid_app_server_event'),
    ('{"method":"truncated"}', 'invalid_app_server_event'),
    ('x' * 256_001 + '\n', 'overlong_app_server_event'),
    (UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid'), 'invalid_app_server_event'),
    (OSError('synthetic pipe failure'), 'app_server_read_failed'),
], ids=['eof', 'json', 'nonobject', 'truncated', 'overlong', 'utf8', 'pipe'])
def test_reader_failure_reaches_waiting_rpc_and_notifications_promptly(protocol, consumer, line, code):
    instance, process = protocol
    if consumer == 'request':
        process.on_send = lambda value: process.stdout.feed(line)
        def consume():
            return instance.request('fixture/response', timeout=2)
    else:
        process.stdout.feed(line)
        def consume():
            return instance.next_notification(timeout=2)

    started = time.monotonic()
    with pytest.raises(ProofFailure, match='^' + code + '$'):
        consume()
    assert time.monotonic() - started < 1
    # Terminal errors remain terminal instead of turning into later timeouts.
    with pytest.raises(ProofFailure, match='^' + code + '$'):
        instance.next_notification(timeout=2)


@pytest.mark.parametrize('completion_index', [511, 512])
def test_513_event_overflow_preserves_prior_events_and_reports_lost_completion(protocol, completion_index):
    instance, process = protocol
    events = [{'method': 'fixture/event', 'params': {'index': index}} for index in range(513)]
    events[completion_index] = {'method': 'turn/completed', 'params': {'index': completion_index}}
    process.stdout.feed(*(encoded(event) for event in events))
    with instance._available:
        assert instance._available.wait_for(lambda: instance._terminal_error is not None, timeout=1)
    assert instance._terminal_error == 'turn_stream_limit'
    assert instance.queue.qsize() == 512

    received = [instance.next_notification(timeout=2) for _ in range(512)]

    assert received == events[:512]
    assert any(event['method'] == 'turn/completed' for event in received) == (completion_index == 511)
    with pytest.raises(ProofFailure, match='^turn_stream_limit$'):
        instance.next_notification(timeout=2)


def test_normal_response_and_completion_precede_eof_in_wire_order(protocol):
    instance, process = protocol
    notice = {'method': 'fixture/before_response', 'params': {'text': 'Ω µ'}}
    complete = {'method': 'turn/completed', 'params': {'turn': {'id': 'synthetic'}}}

    def respond(value):
        process.stdout.feed(encoded(notice), encoded({'id': value['id'], 'result': {'ok': True}}),
                            encoded(complete), '')

    process.on_send = respond
    assert instance.request('fixture/normal', timeout=2) == {'ok': True}
    assert instance.next_notification(timeout=2) == notice
    assert instance.next_notification(timeout=2) == complete
    with pytest.raises(ProofFailure, match='^app_server_closed$'):
        instance.next_notification(timeout=2)


def test_valid_completion_is_not_reordered_behind_following_malformed_event(protocol):
    instance, process = protocol
    completed = {'method': 'turn/completed', 'params': {'turn': {'id': 'finished'}}}
    process.stdout.feed(encoded(completed), '{malformed}\n')
    assert instance.next_notification(timeout=2) == completed
    with pytest.raises(ProofFailure, match='^invalid_app_server_event$'):
        instance.next_notification(timeout=2)


def test_close_wakes_a_blocked_notification_consumer(protocol):
    instance, _ = protocol
    started = threading.Event()
    result = []

    def receive():
        started.set()
        try:
            instance.next_notification(timeout=2)
        except ProofFailure as error:
            result.append(str(error))

    worker = threading.Thread(target=receive)
    worker.start()
    assert started.wait(1)
    instance.close()
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert result == ['app_server_closed']


def test_open_quiet_stream_still_has_retryable_event_timeout(protocol):
    instance, process = protocol
    with pytest.raises(ProofFailure, match='^app_server_event_timeout$'):
        instance.next_notification(timeout=.01)
    notice = {'method': 'fixture/after_timeout'}
    process.stdout.feed(encoded(notice))
    assert instance.next_notification(timeout=1) == notice
