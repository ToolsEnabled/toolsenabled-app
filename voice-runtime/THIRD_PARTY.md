# Upstream references and distribution boundaries

The runtime imports the pinned packages listed in `requirements.lock.txt`.
Windows packaging copies their importable wheel contents and notices into the
private generated `bundle/` directory, together with CPython's `LICENSE.txt`.
The lock is an installation manifest, not a replacement for upstream licenses.

`redistribution-assets.json` identifies the additional model licenses/cards and
the eSpeak NG 1.52.0 and espeakng-loader 0.2.4 source archives, including the
upstream build scripts. Their exact sizes and SHA-256 values are checked before
they enter `bundle/notices`, and again in the staged installer payload. The
eSpeak NG library is GPL-3.0; the loader wrapper is MIT. Those components keep
their own licenses. Model cards identify Whisper weights as MIT and Kokoro
weights as Apache-2.0. The application does not relicense these dependencies.

Builders provision the declared URLs into an explicit `noticesRoot`, alongside
the already installed runtime and models. Packaging stays offline and refuses
missing or changed notices/source archives. Source repositories and generated
private build evidence are not published by the preparation command.

| Component | Authoritative source / license information |
| --- | --- |
| Pipecat 1.8.1 | [Tagged source](https://github.com/pipecat-ai/pipecat/tree/v1.8.1), [BSD 2-Clause license](https://github.com/pipecat-ai/pipecat/blob/v1.8.1/LICENSE) |
| Pipecat SmallWebRTC | [Transport documentation](https://docs.pipecat.ai/api-reference/server/services/transport/small-webrtc) |
| Faster Whisper | [SYSTRAN source and CUDA requirements](https://github.com/SYSTRAN/faster-whisper) |
| CTranslate2 | [Source and license](https://github.com/OpenNMT/CTranslate2) |
| Whisper converted weights | [Pinned model revision](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2/tree/4df90f75321148c3a29a9e2351b7ddf8f5b115a8) |
| Kokoro ONNX | [Source and license](https://github.com/thewh1teagle/kokoro-onnx), [v1.0 model assets](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) |
| Kokoro model | [Upstream model card](https://huggingface.co/hexgrad/Kokoro-82M) |
| ONNX Runtime CUDA | [CUDA provider requirements and DLL loading](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) |
| eSpeak NG | [Upstream license](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING) |
| aiortc | [Source and license](https://github.com/aiortc/aiortc) |
| Cloud speech adapters | [OpenAI speech generation](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text) |

Pipecat's current `WhisperSTTService` demonstrates the CTranslate2 CUDA backend,
but this runtime wraps the model directly so the lazy segment iterator executes
entirely on a worker thread. Its Kokoro adapter creates an explicit CUDA ONNX
session and uses `Kokoro.from_session` rather than the library's default provider
selection. Both are speech services inside a Pipecat media graph; no LLM is added.

The OpenAI Docs skill informed the optional cloud adapters' request formats and
PCM output handling. No cloud API request was performed during validation.
