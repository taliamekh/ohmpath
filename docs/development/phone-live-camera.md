# Direct phone camera

Live help can receive a phone browser's rear camera directly through WebRTC. It uses the same overview video element, fullscreen view, local point tracking and explicit snapshot review as a Windows camera. Camo and OBS are not required for this path.

## Launch and use

On Windows x64, run `scripts/install-phone-camera.ps1` once to download the pinned, SHA-256-checked official cloudflared helper into ignored `runtime/tools`. This does not install a service, create an account or change firewall or browser settings. On other development platforms, install the official free cloudflared binary and supply its absolute path through `OHMPATH_CLOUDFLARED` when launching the app. Rebuild the desktop with `pnpm build`, then restart Ohm Path when no active hardware operation is in progress.

1. Connect laptop and phone to the same private Wi-Fi.
2. In Live help, choose **Connect phone camera**. Ohm Path verifies the secure page before showing its first QR code; a new address may take about a minute to become reachable. The same verified code stays available while this desktop app remains open.
3. Scan the QR code in the phone Camera app. Open the link in Safari or Chrome and tap **Start rear camera**, allowing camera access when asked. After stopping, press Connect on the laptop and Start on the existing phone page again; rescanning the same code also works. Closing Ohm Path or losing the tunnel requires a new code on the next launch/connection.
4. Keep the phone page open and the phone unlocked. The phone requests 1080p at up to 30 fps; the receiver displays actual received dimensions and frame rate. Choose 720p on the phone before starting if the connection needs it.
5. In Ohm Path, select **Take photo for Photo help** to move a snapshot into the standalone Photo help workspace. This does not automatically submit an AI question. Stop the computer preview with the red **Turn off overview** control, or use **Stop camera** on the phone.

Asking suggests a close-up around a compact, textured area in the frame. The live display and snapshot review can enlarge it, while the complete original snapshot is still used for explicit AI questions. **Whole camera view** / **Whole image** restores context. **Choose close-up** lets the user select the center if the suggestion misses the circuit. Ambiguous, blank or broadly textured frames stay wide. This is a local framing heuristic, not component recognition, optical zoom, added detail, or electrical verification. Tracking and annotation coordinates remain relative to the complete image.

Focus remains optical. Move the phone back and improve lighting if components are blurry. Browser continuous autofocus is requested only when its capability is exposed. There is no invented manual-focus control, super-resolution reconstruction or promise that every phone supplies 1080p. Encoding prefers preserving resolution while adapting frame rate/bitrate where supported. Snapshots preserve up to 2400 pixels on the longer side and remain bounded to 2 MB; they do not enlarge smaller frames.

## Connection and privacy

iPhone browser camera access needs a secure origin. A temporary free Cloudflare Quick Tunnel supplies HTTPS for a small pairing page and signaling service bound exclusively to loopback. The tunnel does not expose the bench service, desktop IPC, files, credentials, motor controls or camera pixels. There is no paid fallback or Cloudflare account. Internet is required while the pairing session is active.

The video uses an encrypted direct WebRTC connection with no STUN/TURN servers configured. Both devices need a network that permits direct peer traffic. Guest Wi-Fi, VPN routing or restrictive firewalls may prevent connection. Do not bypass certificate warnings or disable firewall protection to pair. Quick Tunnels are an evaluation/development service without an availability guarantee; a stable production deployment remains future work.

Pairing information, including network candidates, passes through Cloudflare. The capability is a random 32-byte token in the QR URL fragment, removed from phone address history immediately after loading. Authorized requests carry it in a header. The generic page contains no private circuit information. Only one answer can claim a session. No microphone, recording, file upload or continuous AI analysis is enabled by the phone page. Existing Photo help transfer remains a separate feature.

An unanswered media offer expires after ten minutes; active media sessions have a two-hour ceiling. Renderer/phone heartbeat expiry, navigation away, explicit stop, a hidden phone page or peer failure stops that media session. The idle pairing page and its code remain available until Ohm Path quits or the tunnel fails. Every new media session has a fresh ID; delayed answers and stop requests from an older session cannot change its replacement. The helper runs with an isolated empty configuration, independent of any existing Cloudflare setup. The desktop keeps tokens and SDP in memory. The phone retains only its pairing token in same-tab session storage so refreshing that tab can reuse the code; it does not store frames or audio. App shutdown waits for listener/helper cleanup. Camera start remains an explicit phone action each time.

## Verification boundary

Automated tests exercise the production phone page, signaling bridge, React receiver and real WebRTC transfer of synthetic canvas video through an isolated loopback replacement for HTTPS transport. They check 1920×1080 decoded frames, advancing video, explicit snapshot review retaining resolution, no automatic AI request, fullscreen and session/track cleanup. Unit tests exercise authentication, origins, size/media restrictions, cancellation, expiry and isolated helper lifecycle.

The automated runs are software evidence. A subsequent connected-iPhone check received decoded portrait video at 1080×1920 and approximately 30 fps, captured a 1080×1920 snapshot, entered/exited fullscreen, and followed a selected board feature using local image tracking. This confirms that tested phone/browser/network combination; separate browser coverage, fine resistor-band readability, thermal/battery behavior and electrical or turret acceptance remain open.

That check also found two software defects: portrait video could expand the normal page beyond the viewport, and a normal Windows launch could not find the installed Codex executable on PATH. The portrait stage is now bounded without cropping; its synthetic portrait/landscape and responsive-layout test passes. The reasoning adapter now discovers and version-checks the already-installed Codex executable by absolute path. A metadata-only check with normal Windows PATH passed without sending a model turn or image. The original real-circuit question failed before a validated answer; its post-restart retry remains pending.

References: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [WebKit camera access](https://webkit.org/blog/7726/announcing-webrtc-and-media-capture/), [Chrome on iOS architecture](https://developer.chrome.com/blog/chromium-chronicle-28).
