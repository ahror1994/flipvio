#!/usr/bin/env python3
import math, os, random, struct, wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'sfx')

def synth(duration, f_start, f_end, q=2.4, crackles=13, seed=1):
    random.seed(seed)
    n = int(SR * duration)
    out = [0.0] * n
    y1 = y2 = 0.0
    for i in range(n):
        t = i / n
        x = random.uniform(-1.0, 1.0)
        fc = f_start + (f_end - f_start) * (t ** 0.75)
        w = 2.0 * math.pi * fc / SR
        r = math.exp(-w / (2.0 * q))
        a1 = 2.0 * r * math.cos(w)
        a2 = -(r * r)
        y = (1.0 - r) * x + a1 * y1 + a2 * y2
        y2, y1 = y1, y
        env = min(1.0, t / 0.04) * math.exp(-3.1 * t) * (0.55 + 0.45 * math.sin(math.pi * t))
        out[i] = y * env
    for _ in range(crackles):
        pos = int(random.uniform(0.05, 0.9) * n)
        amp = random.uniform(0.12, 0.42)
        length = int(SR * random.uniform(0.0015, 0.006))
        for k in range(length):
            if pos + k >= n:
                break
            d = k / max(1, length)
            out[pos + k] += amp * random.uniform(-1, 1) * math.exp(-9.0 * d)
    peak = max(1e-9, max(abs(v) for v in out))
    return [v / peak * 0.82 for v in out]

def write_wav(name, samples):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in samples))
    print(name, os.path.getsize(path), 'bytes')

if __name__ == '__main__':
    write_wav('flip-1.wav', synth(0.40, 850, 2400, q=2.4, crackles=13, seed=11))
    write_wav('flip-2.wav', synth(0.46, 780, 2900, q=2.1, crackles=16, seed=22))
    write_wav('flip-3.wav', synth(0.36, 980, 2200, q=2.8, crackles=10, seed=33))
    write_wav('flip-hard.wav', synth(0.52, 420, 1500, q=1.7, crackles=7, seed=44))
