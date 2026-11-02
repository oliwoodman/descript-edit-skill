---
name: descript-edit
description: Edits a talking-head video in Descript from its project link by driving web.descript.com in its own Chrome window. Cuts the retakes and pauses, checks the words, turns on Studio Sound if asked, adds captions, a cover line and a slow zoom over the opening line. Never uses Descript's AI agent, never exports or publishes. Use when someone gives a Descript project link and says "edit this", "do the edit", "cut the retakes", "captions and a cover" or "finish this video".
---

# Edit a video in Descript

You record. This skill does the edit in the browser, the way a person would, and leaves the project ready for you to watch and export yourself. It was built on Oli Woodman's own reels (@buildwitholi), where it has finished every video since October 2026. Nothing here exports, publishes or deletes anything it did not add.

## How Descript is reached

- **Descript's own AI agent (Underlord) is never used.** Every call spends AI credits, and they can run out halfway through a video.
- **Edits go through the browser.** `browser/launch.sh "<project link>"` opens the project in its own Chrome window (profile `~/.cache/descript-chrome`, debugging port 9333, window 1600 by 1000), and `node browser/descript.mjs <command>` drives it, one command a call; run it with no command to list them. The first time, Descript sends the window to its sign-in page and the person signs in themselves; the profile keeps the sign-in after that.
- **The window stays at 1600 by 1000.** Every panel lookup depends on it. If the person maximises it or drags it to another screen, put it back before carrying on.
- **Run the helper from a scratch folder,** never from inside a project or repo, because `frames` writes images into the working directory.
- **Never export, publish or delete** beyond a layer this skill added and is replacing.

## Before starting

Set `S=~/.claude/skills/descript-edit` and `D=$S/browser/descript.mjs`, make a scratch folder (`mkdir -p ~/descript-edit-scratch && cd ~/descript-edit-scratch`), and check `$S/node_modules` exists; if not, run `npm install` in `$S`. Ask the person three things, in one message, and nothing else:
1. **The cover line**, the short sentence that sits on the first five seconds, or whether they want you to suggest one from the video.
2. **Studio Sound**, yes or no. It cleans up the audio but spends Descript AI credits (up to 30 a file on Descript's pricing page).
3. **A script**, if they recorded from one. Without one, you work out the takes yourself in step 2.

Then `bash $S/browser/launch.sh "<project link>"`. If Chrome was already running from an earlier edit, it opens the project in a new window and says so; then `export DESCRIPT_PROJECT=<project id>` (the long id in the link) before every helper command, so the helper knows which window to drive. Then `node $D selftest`, which checks the timecode, ruler, transcript and controls read correctly and changes nothing. A FAIL reading a total of 0 straight after opening is the editor still loading; run it again.

## The steps, in order

**1. Read the take.** `node $D transcript` lists the transcript paragraph by paragraph with each paragraph's key.

**2. Decide the takes.** Write a scratch file `takes.md` with a heading `## Takes` and one table under it, one row per line the person meant to keep, in order, each row the words of their **last full take** of that line as Descript transcribed it:

```
## Takes

| # | Said |
|---|---|
| 1 | I've had Claude editing my videos for a month now |
| 2 | One, the connector didn't work |
```

With a script, put the script's lines in instead and run `node $D draft takes.md "Takes"`, which lists their last full take of each row with a match score; read every row under 50 percent against the take and write it as they actually said it. Keep lines they reworded on camera as they said them. Show the person the table before cutting anything, and cut only on their yes.

**3. Cut.** `node $D plan takes.md "Takes"` lists every cut it would make, including a doubled word inside a kept take. Read the list, then `plan takes.md "Takes" --apply` makes the cuts, last first. Then:
- `gaps 1 --delete` takes out every silence of a second or more. `gaps 0.3` lists the shorter ones; if the first is a pause before the first word, `gaps 0.5 --delete` takes it out, but note it deletes the first gap of half a second or more wherever it sits.
- `shortgaps 0.15 --delete` takes out the short pauses inside lines, which `gaps` cannot see.
- **A gap is not always silence.** Descript sometimes leaves a whole take untranscribed, and the gap pass then deletes it. Before `gaps --delete`, check every gap over about two seconds that sits between two takes of the same line; where the words after it continue the line, keep it with `--skip <length>` (comma separated) and cut the untranscribed take by hand.
- **The tail.** A blank stretch after the last line is usually the person reaching for the phone and goes, down to a few frames after the last word, by dragging the last clip's right edge in, zoomed in. But if the transcript ends before the sign-off, the blank may be a line Descript failed to hear: keep it and ask.
- Cutting text at 0:00 also deletes every layer that starts there, so any fix to the opening goes in before step 5.

**4. Check the words.** `node $D check takes.md "Takes"` lists every word that differs from the table. A name that reads wrong is usually Descript mishearing it; fix the spelling with `correct <word> <fixed> [block key]`, which changes the caption and not the audio. A word cut inside a kept line goes through `cut <keyA> "<textA>" before|after <keyB> "<textB>" before|after --dry` first (the block keys from `transcript`, "^" and "$" for the start and end of a block), then without `--dry`, and the transcript is read straight after. Never type into the script: over a selected word, typing opens Regenerate, Descript's paid AI voice.

**5. Studio Sound,** only if they said yes. `studio` turns it on and reads the switch back. With the credits out it shows greyed out and `studio` times out; carry on and say it is off.

**6. Captions.** `captions` applies Descript's "Bold: Two words" style and sizes it to one row of two words just under the chin (W 600 by H 130 at 1080, 2480), and reads the values back. If the frames in step 9 show them on the mouth or too high, `capy <Y>` moves them (2780 puts them on the chest).

**7. The cover.** The cover line word for word, on screen for the first five seconds.
- **The plain route,** always available: `cover "<line>"` adds it as a bold text layer.
- **The designed route,** when the Descript connector is connected in Claude: `node $S/browser/cover-image.mjs cover.png "" "<line>"` renders the line in heavy white capitals as a full-frame transparent PNG (read the PNG before uploading). Upload it to the project's `Overlays` folder with the connector's `import_media` (content type `image/png`, its exact byte size, then a `curl -X PUT` of the file to the returned URL, then `wait_for_job`; never call `report_upload_status` after a PUT that worked). Then `reload` (the editor only lists the new file after one), `seek 0.2`, `drop "cover.png"` (it prints the new clip's id), `place <clip id> 2160 1080 1920`, and `frames 6.5`. If the cover still shows at 6.5 seconds, `reload` and then `trim <clip id> 5.0`; run straight after `place`, `trim` can crash reading the ruler, and a reload first fixes it. It should print "clip ends at 5.00 s".

**8. The slow zoom.** `words` lists the start of every word in the cut; the end of the first line is just before the first word of the second. `zoomhook <end of the first line> <start of the second line>` puts a steady push from 100 to 110 percent across the first line, then back to full frame as the second starts. `zoomat 0.5 <middle of line 1> <end of line 1> <a second into line 2>` is the proof and should read about 100, 105, 110 and 100 percent; the command's own read-back is not.

**9. Check and report.** `check takes.md "Takes" 1.5 4 6.5` reads the gaps, the duration and the words, and saves frames at those seconds; look at them for the captions on one row, the cover readable and gone by about six seconds, and the zoom. Tell the person in a few lines what was done and anything that needs their eye, and give them the project link to watch and export. Leave the Chrome window open.

If any command crashes or reports something odd, `reload` and run it once more before anything else; Descript's editor sometimes needs a fresh page after layers are added.

## Redoing a step

`remove <clip id>` or `remove "<layer name>"` takes off a layer this skill added; `unzoom` clears the zooms. Run `check` straight after every `remove`, before any reload, because a reload empties Descript's undo history. After `remove`, `drop` and `place` a seek can stop moving the playhead, every frame reading the same moment; `reload` fixes it, and Descript has saved by then.

## What the helper guards against

- **A freshly opened project shows black frames until its media loads,** so a frame sheet that reads all black is taken again.
- **The editor page can scroll out of place** and throw every later click off; the helper puts it back before each step.
- **A playing timeline drifts under every reading,** so each command pauses it first.
- **Panels move with the selection,** so everything is found by its label, never a remembered position.
- **Toggles are read before they are set,** so a rerun never switches one back off.
- **One call per change.** A command that adds or moves something is never rerun to see its output again, and its output is never piped into `head` or `tail`, which can kill it halfway.

## When it gets something wrong

Fix it, then write the fix into this file under the step it belongs to, so the next edit does not make the same mistake. That is how this skill got as good as it is.
