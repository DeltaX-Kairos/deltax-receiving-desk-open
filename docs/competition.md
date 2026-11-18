# BuildHybridAI 2026 submission

Enter the Web/Chrome category as a solo entrant. The deadline is November 30, 2026 at 2 p.m. Pacific. Judging ends December 16 at 2 p.m. Pacific. Provide free judge access throughout judging.

The web application must call Firebase AI Logic at runtime, support the Chrome on-device path and cloud fallback, and use Firebase App Check. Show the working application on the submitted platform in a public English or English-subtitled YouTube video of at most three minutes. Include an open-source public judging repository with a detectable license, source, setup instructions, and disclosure of pre-existing code. Keep credentials and debug tokens in private storage.

The four equally weighted judging criteria are technological implementation, design, potential impact and quality of the idea. Demonstrate the receiver’s physical count, review the extraction, explain the decision on a short delivery, and show a conflicting count that stays on hold. Identify Firebase’s actual inference source in both network conditions and distinguish extraction, operator confirmation and hosted decision evidence.

[Official rules](https://firebasehybridaihackathon.devpost.com/rules) · [Firebase web hybrid guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started)

## Verified local runtime

On November 18, Chrome 157.0.8103.79 on Apple Silicon macOS 26.5.1 downloaded its model and produced the count `8` through Firebase JS SDK 13.4.0 in `ONLY_ON_DEVICE` mode. The SDK response identified `on_device`. Chrome’s installed component was `2025.8.8.1141`, with base model `v3Nano` version `2025.06.30.1229`. The organizer published a Firebase response accepting the v3Nano component when accessed through Firebase AI Logic in the Web category. The test used a fictional receiving note.

[Organizer response on v3Nano](https://firebasehybridaihackathon.devpost.com/forum_topics/45895-web-track-verifying-gemini-nano-4-versus-chrome-s-v3nano-component)

For the cloud fallback test on the same Mac, a separate browser reported that the local model was unavailable. The SDK used `PREFER_ON_DEVICE`, returned `in_cloud`, and correctly extracted `8` from the same probe. The dedicated Firebase Spark project had AI Logic and App Check enabled.
