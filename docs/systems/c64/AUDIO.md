# Sound from the original SID writes

All three C64 studies use the same [SID sound model](../../../src/systems/c64/sid-audio.ts) and [browser output](../../../src/web/audio.ts). Original translated instructions still run the game's sound driver and write the chip's frequency, waveform, envelope, routing and volume registers. There are no replacement songs, recorded sound effects or UI-generated game sounds.

The original launch state runs when the page loads. A game key or Enable sound unlocks browser audio through a user gesture, without restarting execution. Sound can be muted using the shared button. Pause, restart, hidden tabs and recovery gaps clear queued audio. Accelerated playback is silent, with a visible note; return to 1× for sound. The scheduler keeps a short buffer rather than accumulating a delayed soundtrack.

Nebulus starts on its original title screen. Play runs the opening music while the game waits for Space, the Fire button or gamepad fire. That input reaches the original joystick reader and initialization code. Restart returns to the title screen. The checked example supplies its own start press; Lemmings continues to launch its first-level checkpoint directly.

## A deliberately small sound model

The model implements three phase accumulators, triangle/sawtooth/pulse/noise waveforms, gate-driven attack/decay/sustain/release, oscillator synchronization, ring modulation, volume, voice-three suppression and approximate low/band/high-pass filtering. Its register controls and frequency equation follow the [original MOS 6581 datasheet, reproduced here](https://www.waitingforfriday.com/?p=661). The code is written for ROM Studio from scratch.

An observer timestamps SID writes using the C64 instruction clock. Synthesis advances to each write before applying it, retaining short gates and volume changes within a frame. Audio is an output observer: it does not change CPU-visible register reads, memory, interrupts or execution timing. Unsupported oscillator/envelope reads still stop explicitly. The [Web Audio API](https://www.w3.org/TR/webaudio/) schedules the resulting PCM buffers.

This is approximate sound, not a measured 6581/8580 replica. Combined waveforms, noise details, analogue filter response and distortion, envelope quirks and bus-phase timing remain unverified. Volume-DAC sample/speech tricks are not reproduced. The gameplay checkpoint retains SID registers but lacks the chip's phase/envelope history; enabling sound starts a declared new audio epoch with phase/envelope zero. Subsequent original writes drive that epoch. No claim of sample equality with a physical C64 follows.

## Evidence

[Sound tests](../../../src/systems/c64/sid-audio.test.ts) check a 440 Hz tone against the PAL frequency equation, exact sample counts, volume/gate silence, finite waveform/filter output, short within-frame gates and rendering independent of chunk boundaries. Bus tests check mirrored register writes and RAM banking.

Each title's export builder enables audio on its recorded example and compares the generated PCM bytes between original-instruction recovery and static replay, in addition to the existing machine and raster comparisons. It also rejects an example that produces only silence. Those checks establish deterministic output from the same original write stream; they do not establish hardware sound fidelity.

Nebulus additionally compares the idle title music and the tunnel/next-doorway and delayed-jump routes. The delayed jump reaches `$F311`; the sound driver's known direct branches are now included through `$FFFF`. Code for that original driver remains in the game's emitted program; the shared synthesizer stays in `src/systems/c64/`. See [the game walkthrough](../../../src/games/c64/nebulus/docs/GAMEPLAY.md) and [source layout](../../ARCHITECTURE.md).
