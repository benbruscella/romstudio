# Super Mario 64 startup

The original header declares CPU entry **$80241800**. Its entry instructions begin at ROM offset **$1000**, after the cartridge header and boot area. The normalized image exactly matches the European ROM hash recorded by [the matching decompilation](https://github.com/n64decomp/sm64/blob/master/sm64.eu.sha1).

The entry code constructs the BSS start and length, clears two words per iteration, initializes the idle-thread stack and jumps to the main function. A MIPS branch executes a delay-slot instruction: the final store-pointer increment and the stack adjustment before `JR` are part of the original program, not optional scheduling hints. See the independently named [entry source](https://github.com/n64decomp/sm64/blob/master/asm/entry.s) and [segment layout](https://github.com/n64decomp/sm64/blob/master/sm64.ld).

For this exact image, the entry words describe BSS at **$80307E50**, length **$2F0C0**, main at **$80242E80**, and stack at **$801FBA00**. These are observations from the supplied bytes, not addresses borrowed from the US release.

## Declared startup fixture

The cartridge boot program and console initialization are a separate stage. The full CPU study starts from a post-IPL3 fixture: 4 MiB of zero-filled RDRAM, zeroed general registers, and 1 MiB copied from ROM+$1000 to the header entry address. It supplies PAL type at `$80000300`, cartridge base `$B0000000` at `$80000308`, and RAM size at `$80000318`. One standard controller and 512-byte EEPROM are attached. This fixture is not a verified console reset.

The isolated entry test uses a different, deliberately nonzero fixture and compares all modified registers and memory against an independently named BSS interpretation. The longer run executes the original OS initialization, thread creation/switching, exception vectors and cartridge segment loading until the first RSP task is requested. This checkpoint is reached before controller transactions; SI/controller/EEPROM behavior has synthetic device tests, while the game's later input and save paths remain unverified.

The build records observed CPU words, emits static functions and replays the same startup on a fresh machine. It compares CPU state, all RDRAM, SP memory, device state, clock and the task boundary. Shared architectural helpers mean this comparison checks translation consistency; independent hardware parity remains unverified.

The first SP descriptor, exact start command, registers and memories are retained in the startup report. A separate paused-CPU fixture completes the first original RSP audio task: 22,566 instructions, 415 observed address/word shapes, and eight comparison checks. Fifteen additional MIXER fixtures compare 320 sample positions against a named interpretation. See [Audio](AUDIO.md). The optional [graphics studies](GRAPHICS.md) continue to actual task handoffs and verify frame/depth clears, a vertex/texture prefix and a complete textured drawing task in separate fixtures. Their supplying CPU captures remain distinct from the title-to-opening replay below. Hardware pixel precision, browser-player acceptance, audible music, complete input/save behavior and progression remain release work.

## Later title and menu observations

Exploratory native CPU/RSP execution now draws the animated logo and Mario's title-screen head. A Start press delivered through SI triggers the original fade, audio-session reset and menu loading. With blank EEPROM, this European release opens sound/language settings automatically; the [original file-select code](https://github.com/n64decomp/sm64/blob/master/src/menu/file_select.c) explains that first-boot behavior. Moving the analog cursor and pressing A on Return reaches the four-file menu through the original code.

Selecting an empty file with the same controller endpoint starts Peach's opening scene. That continuation reaches 283 RDP FullSyncs and 1,566,076,466 functional ticks without a new backend stop. It still does not validate ordinary movement, saves, level progression or a browser player.

The reset waits for the original audio thread across several frames before rendering resumes. No game routine, queue acknowledgment or menu state is replaced to force progress. Those exploratory captures remain under `dist/work/games/n64/sm64/analysis/intro/`.

A subsequent title-to-opening run starts at FullSync 131 and reaches 284 through original controller input. Fresh static CPU/RSP replay matches processor/device/clock state, all RDRAM and SP memory, with continuing controller traffic. Its record and hashed inputs live under `analysis/playback/<fingerprint>/`. This checks that recorded route and source snapshot; it does not retroactively validate the earlier CPU captures, changed source or browser execution. The worker player is in progress. Visible artifacts, performance, normal gameplay and saving remain unfinished; [project status](../../../../../docs/PROJECT-STATUS.md) records acceptance and the current NES-audio priority.
