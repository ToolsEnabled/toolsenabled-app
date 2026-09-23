# Voice from a browser or phone

The browser captures microphone audio and plays the answer. The selected,
connected computer runs the existing speech runtime and its GPU models. It keeps
the existing single-contact reservation shared with desktop voice. The remote
adapter accepts only the computer's local provider; it does not introduce another
speech engine, a cloud key, or a CPU fallback.

The website host bridge exposes `mcVoice` through the existing authenticated,
sealed computer connection. The desktop agent facade handles POST requests at
`/v1/agent/voice/{targets,start,poll,offer,reply,interrupt,stop}`. Its existing
bearer, origin, request limits and principal remain authoritative. Voice requires
web control to be enabled on that computer and an agent owned by the relay
principal. This does not grant control of agents owned by another desktop window.

Each browser contact carries a fresh UUID and its selected computer generation.
GPU startup responds promptly with a preparing state, then polling renews a
45-second lease. Permission revocation, lease expiry, an event gap or a changed
computer ends the contact. Old events and canceled starts cannot bind to a new
contact. The frontend closes microphone tracks on End, failure and page exit.
Changing application screens retains the existing voice controller and audio
element; the active contact stays available in its voice dock.

Audio uses the existing WebRTC connection. No new public loopback endpoint,
microphone discovery scan, or third-party STUN/TURN service is added. Direct
connectivity across different NATs is not established by this implementation's
tests and requires a real network acceptance run. An unreachable media peer
times out with an actionable error and typed chat remains available.

The site must serve HTTPS and allow `microphone=(self)` on `/app/`. Its account
and marketing documents continue to deny microphone access. `tools/serve.mjs`
in the website expresses that policy; production headers require independent
verification. Phones may refuse autoplay, so the panel supplies a **Play voice**
button that retries playback from a person's tap.

## Verification

Run the app's voice host, relay, controller, race, HTTP facade and rendered voice
tests through the existing Node test suite. The website adds
`tools/test/web-voice-client.test.mjs` and `npm run drive:mobile:workflow` to its
existing phone checks. The latter drives WebKit phone profiles and actual Android
Chrome, presses controls, captures checkpoints and retains failure traces.

Voice UI fixtures deliberately use synthetic media and computer responses. Their
pass proves control behavior, permissions policy and cleanup, not speech inference
or an authenticated conversation. A customer acceptance run still needs a test
account, an answering computer with installed speech models, and a running agent:

1. Start voice from the phone or web app, grant the microphone and speak a unique
   test phrase. Confirm the selected agent receives it exactly once.
2. Hear its response on the initiating device, including an initial blocked
   autoplay recovery. Confirm no other agent receives the transcript.
3. Exercise mute, interrupt, End, screen navigation and a second contact refusal.
4. Switch computers, revoke web control and disconnect the network. Confirm the
   old audio tracks close and the computer releases the contact.
5. Repeat on Android Chrome and physical iPhone Safari, including portrait,
   landscape, keyboard, background/foreground and standalone launch.

Keep screenshot hashes and the device/computer identities with the report.
Browser profiles, USB pairing, synthetic signals and a native app smoke test each
have their own scope; none alone certifies a physical iPhone voice conversation.
