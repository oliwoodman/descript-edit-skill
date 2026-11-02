# Descript edit skill

A Claude Code skill that edits a talking-head video in Descript for you. You record, give Claude the project link, and it opens Descript in its own Chrome window and does the edit the way you would: it cuts the retakes and the pauses, checks the words, adds captions, a cover line and a slow zoom over your opening line, and turns on Studio Sound if you want it. Then it hands the project back for you to watch and export.

It was built by [Oli Woodman](https://oliwoodman.com) (@buildwitholi on Instagram) on his own reels, where it has edited every video since October 2026. This is his skill with the overlay cards taken out.

## What you need

- Claude Code
- Google Chrome
- Node.js 18 or newer
- A Descript account, with the video already uploaded to a project

It never uses Descript's AI agent, so it does not spend your AI credits, except Studio Sound, which it asks about first. It never exports, publishes or deletes your work.

## Install

Paste this into Claude Code:

```
Install the Descript edit skill from https://github.com/oliwoodman/descript-edit-skill.
Clone it into ~/.claude/skills/descript-edit, run npm install inside that folder,
and check I have Node 18 or newer and Google Chrome installed. If anything is
missing, tell me what and how to get it rather than installing it yourself.
Don't change anything else on my machine. Tell me when it's ready.
```

## Use it

```
Edit my Descript project <paste the project link> with the descript-edit skill.
```

Claude asks you three things (the cover line, whether you want Studio Sound, and whether you recorded from a script), opens the project, and shows you the takes it plans to keep before it cuts anything. The first time, sign in to Descript in the window it opens; it remembers you after that. Leave the window at the size it opens at while it works.

An edit takes about half an hour. That is slower than doing it yourself, and it does not matter, because you are not the one doing it.

## How it works

`browser/launch.sh` opens Chrome with a debugging port, and `browser/descript.mjs` drives the Descript editor over it, one command at a time. `SKILL.md` is the method Claude follows, step by step. When it gets something wrong, ask it to write the fix into `SKILL.md`, so it does not happen twice.

Descript changes its editor from time to time, so a command can break. If one does, tell Claude what happened and ask it to fix the helper.
