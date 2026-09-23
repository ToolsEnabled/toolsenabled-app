"""Measure speech-to-text latency and accuracy on THIS machine.

PLAN.md section 6 lists this as the largest unmeasured unknown in the project,
so it is measured before anything is built on top of it.

The test sentences use the vocabulary that will actually be spoken at this
document (determinacy, QuantConnect, LEAN, Wilson interval, saturate). General
word error rates say nothing about whether a model can hear "LEAN-Bench", and
that is the only accuracy that matters here.

Audio is synthesized with edge-tts, which is already installed. Synthetic speech
is cleaner than a real microphone, so treat these numbers as a floor: real
latency will be similar (it is compute bound) but real accuracy will be worse.

Run: python test/bench_stt.py
"""

import asyncio
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, "_bench_audio")

SENTENCES = [
    "Only three of twenty tasks were determinate.",
    "Replace the phrase about the semantic edge with something sharper.",
    "What did the QuantConnect audit actually find about judge disagreement?",
    "Add a sentence saying the benchmark saturates on unambiguous prompts, "
    "and cite the Wilson confidence interval.",
]

# Words that must survive transcription for the app to be usable.
KEY_TERMS = ["determinate", "semantic", "quantconnect", "audit", "judge",
             "benchmark", "saturates", "wilson", "twenty", "replace"]


async def synth():
    import edge_tts
    os.makedirs(AUDIO, exist_ok=True)
    paths = []
    for i, s in enumerate(SENTENCES):
        mp3 = os.path.join(AUDIO, f"s{i}.mp3")
        wav = os.path.join(AUDIO, f"s{i}.wav")
        if not os.path.exists(wav):
            await edge_tts.Communicate(s, "en-US-AriaNeural").save(mp3)
            # 16 kHz mono is what whisper wants, and what the browser will send.
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3,
                            "-ar", "16000", "-ac", "1", wav], check=True)
        paths.append(wav)
    return paths


def vram_used():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True)
        return int(out.strip().split("\n")[0])
    except Exception:
        return -1


def duration(wav):
    import wave
    with wave.open(wav) as w:
        return w.getnframes() / float(w.getframerate())


def bench(size, wavs, device="cuda", compute="float16"):
    from faster_whisper import WhisperModel

    base_vram = vram_used()
    t0 = time.perf_counter()
    model = WhisperModel(size, device=device, compute_type=compute)
    load_s = time.perf_counter() - t0
    loaded_vram = vram_used()

    # First call includes lazy graph setup; do not let it pollute the median.
    list(model.transcribe(wavs[0], beam_size=1)[0])

    rows, hits, total_terms = [], 0, 0
    for w, sentence in zip(wavs, SENTENCES):
        dur = duration(w)
        t = time.perf_counter()
        segs, _info = model.transcribe(w, beam_size=1, language="en",
                                       vad_filter=False, condition_on_previous_text=False)
        text = " ".join(s.text for s in segs).strip()
        el = time.perf_counter() - t
        rows.append((dur, el, text))

        low = text.lower()
        want = [k for k in KEY_TERMS if k in sentence.lower()]
        got = [k for k in want if k in low]
        hits += len(got)
        total_terms += len(want)

    peak_vram = vram_used()
    del model
    try:
        import torch, gc
        gc.collect(); torch.cuda.empty_cache()
    except Exception:
        pass

    return {
        "size": size, "load_s": load_s,
        "vram_mb": max(0, loaded_vram - base_vram),
        "peak_mb": max(0, peak_vram - base_vram),
        "rows": rows,
        "term_recall": (hits / total_terms) if total_terms else 0.0,
    }


def main():
    print("synthesizing test audio…")
    wavs = asyncio.run(synth())
    total_audio = sum(duration(w) for w in wavs)
    print(f"{len(wavs)} utterances, {total_audio:.1f}s of speech, free VRAM baseline {vram_used()} MiB used\n")

    sizes = sys.argv[1:] or ["small", "medium"]
    results = []
    for size in sizes:
        print(f"=== {size} ===")
        try:
            r = bench(size, wavs)
        except Exception as e:
            print(f"  FAILED: {type(e).__name__}: {e}\n")
            continue
        results.append(r)
        print(f"  load {r['load_s']:.1f}s   weights ~{r['vram_mb']} MiB   peak ~{r['peak_mb']} MiB")
        lat = []
        for dur, el, text in r["rows"]:
            lat.append(el)
            rtf = el / dur if dur else 0
            print(f"  {dur:4.1f}s audio -> {el * 1000:6.0f} ms  (RTF {rtf:.2f})  {text[:74]}")
        lat.sort()
        med = lat[len(lat) // 2]
        print(f"  median {med * 1000:.0f} ms per utterance, key-term recall {r['term_recall'] * 100:.0f}%\n")

    if results:
        print("VERDICT")
        for r in results:
            lat = sorted(e for _d, e, _t in r["rows"])
            med = lat[len(lat) // 2] * 1000
            verdict = "usable" if med < 900 else ("borderline" if med < 2000 else "too slow")
            print(f"  {r['size']:8s} {med:6.0f} ms median   ~{r['peak_mb']:5d} MiB   "
                  f"recall {r['term_recall'] * 100:3.0f}%   {verdict}")
        print("\nBudget: 2.6 GB of verified simultaneous headroom (PLAN.md 1.8).")
        print("Endpoint-to-text is what the human feels: add ~200 ms of VAD "
              "silence detection to the numbers above.")


if __name__ == "__main__":
    main()
