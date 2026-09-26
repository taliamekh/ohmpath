# ElevenLabs account connection

This change links account credentials and a voice choice without generating or previewing speech. The user explicitly prohibited voice tests and credit-consuming requests. Speech playback remains unimplemented in this connection adapter and unverified; connecting an account is not evidence of working spoken output.

## Link without spending credits

Restart the prepared Ohm Path desktop, open Settings, and find ElevenLabs. Enter a restricted API key and choose **Link account · no speech**. The key needs access to User, Models and read access to Voices for the metadata check. Text to Speech permission can be prepared for the later playback implementation; this adapter never calls a synthesis endpoint.

The proposed account key is named **Ohm Path voice**, has a 1,000-credit cap per credit-refresh period, and has no permissions for agents, voice cloning/design, music, transcription, projects, history, workspace administration or other generation features. Creating the persistent key is a separate account action; local setup does not create it. No payment or upgrade is needed for the linking workflow.

The main process stores the API key and sanitized metadata encrypted with Electron `safeStorage` in `%APPDATA%\ohmpath\private\elevenlabs.enc`. On Windows, this uses the current Windows account's protected storage. There is no plaintext fallback. The API key never enters the bench database, model subprocess, exported reports or repository. The password entry is cleared on submission. Removing the local link does not revoke the provider-side API key.

Settings reads saved connection information locally. **Refresh account information** explicitly fetches the current metadata again. Selecting a voice saves its identifier only: there is no preview or generation button. Account credit counts are separate from the key's smaller configured cap. An unknown or nonzero overage allowance is flagged as blocking future spending.

## Browser handoff

When linking from the already signed-in browser, the coordinator can start:

```powershell
./node_modules/electron/dist/electron.exe scripts/link-elevenlabs.cjs
```

This prints a temporary loopback URL. Open it on the same computer, enter the key, and finish the link. It starts no bench service, camera, microphone, audio or browser automatically. The page has a random capability path, exact loopback Host and POST Origin checks, bounded form size and a 15-minute idle expiry. No third-party resources, scripts, frames or cross-origin requests are allowed. **Finish and close this link** stops the temporary server. The temporary URL is not an API key but should still be kept private while active.

For isolated development data, `--data-dir <absolute directory>` stores in that directory's `desktop/private` folder; the normal desktop's `OHMPATH_DATA_DIR` follows the same layout.

## Boundaries and verification

The only provider requests are authenticated HTTPS GETs to:

- `/v1/user/subscription`
- `/v2/voices?page_size=100`
- `/v1/models`

Redirects are rejected, responses and timeouts are bounded, and raw provider errors or credential values are never returned to the renderer. No synthesis, voice preview, agent creation, billing change, purchase or provider write is exposed. Local actions are limited to status, connect, refresh, voice selection and disconnect. The same trusted-main-window IPC check protects these actions; the companion cannot access them.

Offline tests use invented account metadata and a fake credential. The desktop check opens the actual Settings panel in an isolated profile and submits an intentionally invalid short key, which fails before network access. It does not invoke speech. Live account verification, if completed, consists only of metadata requests and is recorded separately in the progress log.

Future work: connect the approved-answer/readback player to ElevenLabs, retain cancellation and confirmation binding, drive character mouth animation from actual playback, and obtain permission before any live voice test. Do not add automatic playback, a test utterance on connection, provider calls in routine test suites, or a paid fallback.
