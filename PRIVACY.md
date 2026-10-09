# Privacy

Last updated: October 9, 2026

House Rules is a mod that runs inside Claude Code on your own machine. It has no server and no account.

## What it collects

Nothing. House Rules does not collect, transmit or share any data. It makes no network requests, calls no model, and sends no telemetry or analytics. The author receives no information about you or your use of it.

## What it handles on your machine

To do its job, House Rules works with the following, all of which stay on your computer:

- **During a session, in memory:** the shell commands and file paths Claude asks to use, read at the moment Claude Code decides whether each may run, and a short log of the times a rule stepped in. This is held by Claude Code for the length of the session and is gone when the session ends.
- **In your project:** it reads `.house-rules.json`, and writes that file once if you run `/house-rules init` and it does not exist yet.
- **One command it runs:** `git branch --show-current`, to learn which branch a `git push` with no branch named would push.

Nothing is kept between sessions.

## Removing its data

Uninstalling the plugin stops all of the above. `.house-rules.json` is a file in your project and is yours to keep or delete.

## What House Rules does not cover

House Rules runs inside Claude Code. How Claude Code and Anthropic handle your prompts, code and usage is governed by Anthropic's own policies, not this one.

## Changes

Any change to this policy will be made in this file, and the history is visible in the repository.

## Contact

Questions or concerns: open an issue at https://github.com/ramankrishna/house-rules-guard/issues
