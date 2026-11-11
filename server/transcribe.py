# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["faster-whisper>=1.1", "av<14.3"]
# ///
# The voice note's words: faster-whisper on the CPU,
# the small English model, int8. The bridge runs this through uv for each
# audio attachment and appends what it prints to the note. The header above
# is what uv installs: PyAV 15 dropped an argument faster-whisper still
# passes, and 14.3 and 14.4 ship no Windows wheels, so it stays at 14.2.
# Prints the text alone on stdout; anything else goes to stderr.
#
#   uv run server/transcribe.py <audio file>

import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe.py <audio file>", file=sys.stderr)
        return 2
    from faster_whisper import WhisperModel

    model = WhisperModel("small.en", device="cpu", compute_type="int8")
    segments, info = model.transcribe(sys.argv[1], beam_size=5, vad_filter=True)
    words = " ".join(s.text.strip() for s in segments).strip()
    print(f"{info.duration:.1f}s of audio", file=sys.stderr)
    print(words)
    return 0


if __name__ == "__main__":
    sys.exit(main())
