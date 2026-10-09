# House Rules

A mod for Claude Code that enforces the standing rules you would otherwise paste into every prompt.

"Don't push to main. Don't force push. Don't add dependencies without asking." Written in a prompt, those are requests, and an agent can forget them halfway through a long session. House Rules checks every shell command and file edit at the point where Claude Code decides whether it may run, so the rule holds whether or not Claude remembers it.

It asks no model anything. Every decision comes from rules you can read in `hooks/rules.ts`.

## The rules

| Rule | Default | What it covers |
| :- | :- | :- |
| Push to a protected branch | ask | `git push origin main`, `HEAD:main`, and a bare `git push` while a protected branch is checked out |
| Force push | deny | `--force`, `-f`, `--force-with-lease`, and `+branch` refspecs |
| Destructive commands | ask | `rm -r`, `git reset --hard`, `git clean -f`, `git checkout -- .`, `git branch -D`, deleting a remote branch, `DROP TABLE`, and a few others |
| New dependencies | ask | `npm install <package>`, `pip install <package>`, `cargo add` and their relatives, plus edits to the dependency sections of a manifest |
| Protected paths | ask | Writing `.env`, `.env.*`, `*.pem` or `*.key` |

Each rule has one of three settings:

- **ask**: Claude Code puts the call to you, with the reason shown.
- **deny**: the call is refused, and Claude is told why and what to do instead.
- **allow**: the rule is off.

A rule only ever tightens. It never approves a call that something else refused.

## Install

```
/plugin install house-rules-guard --marketplace ramankrishna/house-rules-guard
```

Answer `y` to add the marketplace, then pick a scope. Needs Claude Code v2.1.287 or later.

The defaults apply as soon as it is installed. There is nothing to set up.

## Change the rules

Run `/house-rules init`, or write `.house-rules.json` at the project root yourself:

```json
{
  "protectedBranches": ["main", "release"],
  "rules": {
    "pushToProtectedBranch": "deny",
    "forcePush": "deny",
    "destructiveCommands": "ask",
    "newDependencies": "ask",
    "protectedPaths": "ask"
  },
  "protectedPaths": [".env", ".env.*", "*.pem", "*.key", "infra/prod/**"],
  "custom": [
    { "match": "terraform apply", "mode": "ask", "why": "applies infrastructure changes" },
    { "match": "/\\bkubectl\\b.*\\bprod\\b/", "mode": "deny", "why": "touches the production cluster" }
  ]
}
```

- Anything you leave out keeps its default.
- A `custom` rule matches plain text inside the command, or a pattern when written between slashes.
- Claude must ask before changing `.house-rules.json` itself, whatever the rules say. It cannot quietly loosen the rules it works under.
- If the file does not parse, the defaults stay in force and `/house-rules` says what is wrong.

## See what happened

`/house-rules` opens a pane with two tabs:

- **Rules**: every rule and its setting.
- **Log**: each time a rule stepped in this session, and whether the call was blocked, allowed by you, or refused by you.

## What it runs, reads and stores

- **Reads** `.house-rules.json` at the project root.
- **Writes** `.house-rules.json` once, only when you run `/house-rules init` and the file does not exist.
- **Runs** `git branch --show-current`, only when Claude runs a `git push` that names no branch, to learn which branch would be pushed.
- **Stores** nothing between sessions. The log lives in the session and ends with it.
- **Sends nothing.** No network calls, no model calls, no telemetry.

Like every mod, it runs with the same access to your machine as Claude Code itself. The full statement is in [PRIVACY.md](PRIVACY.md).

## Limits

- **"Ask" follows your permission mode.** In a mode where Claude Code does not show permission dialogs, an ask is settled by that mode and not by you. Use "deny" for any rule that must hold everywhere.
- **It reads commands, it does not run them.** A rule matches how a command is written. A script that force pushes from inside, or a command built up in a variable, will get past it. Protect important branches on your git host as well.
- **Reading is not covered.** The protected paths rule stops writes. It does not stop Claude from reading a file.
- **The dependency rule is a heuristic.** It recognises the common package managers and manifest files, not every one.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
