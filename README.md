# TB-303 Companion - User Manual

This guide is for musicians and users who want to create, edit, and export TB-303 pattern sheets quickly.

![TB-303 Companion full interface](docs/screenshots/overview-main.png)

## 1. Main goal: export printable pattern sheets

![Sheet export view](docs/screenshots/sheet-export.png)

The main workflow is:

1. Build your pattern(s) in **Editor**
2. Set voice count to **1, 2, or 3** from **Menu... > Voices**
3. Open **Sheet** tab
4. Click **Refresh**
5. Click **Save PNG**

The export includes as many lines (voices) as selected: 1, 2, or 3.

## 2. Main app options (top bar)

![Top bar options](docs/screenshots/header-options.png)

Use the top bar for your most frequent actions:

- **Play / Stop**: start or stop playback.
- **Reset**: clear the current time grid.
- **Save**: save current edits to the selected pattern.
- **Normal / Triplet** button: toggles timing mode.
- **Program**: rename your working program.
- **Pattern**: pick which saved pattern you are editing.
- **Menu...**: opens extra actions (length, voices, library, import/export, backup, etc).

## 3. Sequencer editor (notes and timing)

![Mobile sequencer view](docs/screenshots/mobile-sequencer.png)

In **Editor** view:

- Tap a pitch cell to place/remove notes.
- Use the lower lanes per step:
  - **DOWN / UP** = transpose
  - **ACC** = accent
  - **SLIDE** = glide
  - **TIME** = `N` (note), `T` (tie), `R` (rest)

This is where you build the full pattern groove.

## 4. TB-303 controls (sound shaping)

![TB-303 controls and sequencer](docs/screenshots/overview-main.png)

Open **Controls** to access synth knobs:

- **Tune**: shifts the oscillator pitch up/down.
- **Cutoff**: opens/closes the filter brightness.
- **Resonance**: emphasizes filter peak for acid character.
- **Env Mod**: controls how strongly the envelope pushes the filter.
- **Decay**: short/long note contour.
- **Accent**: strength of accented notes.

For authentic 303 phrasing, combine these with sequencer lanes:

- **ACC** lane for accented steps
- **SLIDE** lane for glide between notes
- **TIME** lane (`N/T/R`) for rhythm and ties

## 5. FX controls (delay, distortion, reverb, level)

In the same controls area you can tweak effects:

- **SYNC/FREE** + delay subdivision
- **Delay Time**
- **Feedback**
- **Delay Mix**
- **Distortion**
- **Reverb**
- **Volume**

Use small changes first, then fine-tune while pattern is playing.

## 6. How to change pattern length

1. Open **Menu...**
2. Select **Length**
3. Enter the number of steps and confirm

Tip: shorter lengths are great for looping acid phrases.

## 7. How to save edits

1. Make your note/timing/sound changes
2. Press **Save** in the top bar

Your current pattern is updated immediately.

## 8. Pattern and library management

From **Menu...**:

- **New Pattern**: start a fresh pattern.
- **Delete Pattern**: remove selected pattern.
- **Voices**: choose active voices (1-3).
- **Library**: switch target library.
- **New Library / Delete Library**: organize your pattern sets.

## 9. Import, export, and backup

From **Menu...**:

- **Export JSON**: save your project file.
- **Import JSON**: load a saved project file.
- **Connect Google Drive**: enable cloud backup.
- **Backup to Google Drive now**: force backup immediately.

## 10. Quick workflow (recommended)

1. Press **Play**
2. Enter notes in **Editor**
3. Set **TIME** lane (N/T/R)
4. Shape sound with 303 + FX controls
5. Set **Length** from **Menu...**
6. Press **Save**
