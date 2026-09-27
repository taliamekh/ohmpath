# Direct phone camera

Live help can receive a phone browser's rear camera directly through WebRTC. It uses the same overview video element, fullscreen view, local point tracking and explicit snapshot review as a Windows camera. Camo and OBS are not required for this path.

## Launch and use

On Windows x64, run `scripts/install-phone-camera.ps1` once to download the pinned, SHA-256-checked official cloudflared helper into ignored `runtime/tools`. This does not install a service, create an account or change firewall or browser settings. On other development platforms, install the official free cloudflared binary and supply its absolute path through `OHMPATH_CLOUDFLARED` when launching the app. Rebuild the desktop with `pnpm build`, then restart Ohm Path when no active hardware operation is in progress.

1. Connect laptop and phone to the same private Wi-Fi.
2. In Live help, choose **Connect phone camera**. Ohm Path verifies the secure page before showing the QR code; new addresses may take about a minute to become reachable.
3. Scan the temporary QR code in the phone Camera app. Open the link in Safari or Chrome and tap **Start rear camera**, allowing camera access when asked.
4. Keep the phone page open and the phone unlocked. The phone requests 1080p at up to 30 fps; the receiver displays actual received dimensions and frame rate. Choose 720p on the phone before starting if the connection needs it.
5. In Ohm Path, select **Ask about this view** to prepare a snapshot for review. This does not automatically submit an AI question. Stop with **Disconnect phone**, or **Stop camera** on the phone.

Focus remains optical. Move the phone back and improve lighting if components are blurry. Browser continuous autofocus is requested only when its capability is exposed. There is no invented manual-focus control, super-resolution reconstruction or promise that every phone supplies 1080p. Encoding prefers preserving resolution while adapting frame rate/bitrate where supported. Snapshots preserve up to 2400 pixels on the longer side and remain bounded to 2 MB; they do not enlarge smaller frames.

## Connection and privacy

iPhone browser camera access needs a secure origin. A temporary free Cloudflare Quick Tunnel supplies HTTPS for a small pairing page and signaling service bound exclusively to loopback. The tunnel does not expose the bench service, desktop IPC, files, credentials, motor controls or camera pixels. There is no paid fallback or Cloudflare account. Internet is required while the pairing session is active.

The video uses an encrypted direct WebRTC connection with no STUN/TURN servers configured. Both devices need a network that permits direct peer traffic. Guest Wi-Fi, VPN routing or restrictive firewalls may prevent connection. Do not bypass certificate warnings or disable firewall protection to pair. Quick Tunnels are an evaluation/development service without an availability guarantee; a stable production deployment remains future work.

Pairing information, including network candidates, passes through Cloudflare. The capability is a random 32-byte token in the QR URL fragment, removed from phone address history immediately after loading. Authorized requests carry it in a header. The generic page contains no private circuit information. Only one answer can claim a session. No microphone, recording, file upload or continuous AI analysis is enabled by the phone page. Existing Photo help transfer remains a separate feature.

Waiting codes expire after ten minutes; sessions have a two-hour ceiling. Renderer/phone heartbeat expiry, a closed app, navigation away, explicit stop, hidden phone page or peer failure stops the session. The helper runs with an isolated empty configuration, independent of any existing Cloudflare setup. Tokens and SDP remain in memory, and the helper process terminates when the link closes. The phone releases tracks immediately on its Stop action and, after a dropped connection, on peer failure or bounded signaling failure detection.

## Verification boundary

Automated tests exercise the production phone page, signaling bridge, React receiver and real WebRTC transfer of synthetic canvas video through an isolated loopback replacement for HTTPS transport. They check 1920×1080 decoded frames, advancing video, explicit snapshot review retaining resolution, no automatic AI request, fullscreen and session/track cleanup. Unit tests exercise authentication, origins, size/media restrictions, cancellation, expiry and isolated helper lifecycle.

This is software evidence, not a physical iPhone test. Actual Safari/Chrome permission behavior, camera lens/focus quality, network compatibility and thermal/battery behavior still require a user's connected phone. Quick Tunnel HTTPS reachability is verified separately from media transfer. No electrical or turret acceptance is implied.

References: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [WebKit camera access](https://webkit.org/blog/7726/announcing-webrtc-and-media-capture/), [Chrome on iOS architecture](https://developer.chrome.com/blog/chromium-chronicle-28).
