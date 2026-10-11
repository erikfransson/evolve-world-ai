# Notes

## Progress
| ID  | Objective                                        | Status                                                    |
| --- | ------------------------------------------------ | --------------------------------------------------------- |
| A1  | Render tooling (Node canvas to ffmpeg)           | done, ~5 ms/frame for the landing scene at 720p          |
| A2  | Style and face samples for Erik to rate          | in progress: emotions story in classic, cute, neon        |
| A3  | Compare with another stack (Motion Canvas etc.)  | open                                                      |
| B1  | Sound: synthesized effects and CC0 assets         | open                                                      |
| C1  | Trailers 15/30/60 s                              | after Erik rates the samples                              |
| R1  | Independent reviews (2-3 Opus, 1 Fable)          | open, each round rates video quality only                 |

## Brief from Erik (2026-10-11)
- Cute, polished videos from the landing animations: 10-60 s, trailer variants, scene changes, zooms, sound effects.
- Faces that react: happy eating, sad or sick after poison, angry when bumped, brain highlighted when learning.
- Both "same look plus faces" and "cuter redesign"; draft 2-3 samples, Erik rates, iterate.
- CC0 assets allowed. Do not commit videos; commit plans, READMEs and notes.
- By morning: 3-10 finished samples in `videos/out/` for Erik to rate, polished until the reviewers and I are happy, then ask Erik.

## Log
- 2026-10-11: Node + @napi-rs/canvas renders the real landing scene unchanged, so no browser is needed. ffmpeg in conda env `videos`. Font Fredoka (OFL).
- Face rig v1: 13 parameters, 11 emotions. Brows and lids were mirrored at first (sad read as angry), fixed.
- Emotions story v1 (cute): reads well. Fixed: food in columns, speed stretch too strong, cute nose nub looked like a speech-bubble tail (now feelers), unclear avoidance beat (now stop, eye shake, "nope!", veer).
