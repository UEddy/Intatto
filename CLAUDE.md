# CLAUDE.md

## File access boundaries

- Never search or read outside `~/dev/intatto` and `~/dev/intatto-cs`. The only exceptions are `~/.config/intatto` and `~/.near-credentials`, and only when the task names them.
- Never search the home folder (`~`) or `/mnt` by file name (no `find`, `locate`, `ls -R`, globbing, or similar).
- When a referenced file isn't in the repo, ask me instead of looking for it.
- `HACKATHON.md` is not in the repo; it's public at https://nearhackathon.com/HACKATHON.md. Fetch it from there when needed.
