COMPONENT: Audio

A sound player: a round disc that spins while playing, with the title above it and controls below. It does not start by itself.

Written as `<Audio src="https://..." title="..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a sound file | Required. The file itself (mp3, wav or ogg). |
| title | text | The heading above the player. Without it the heading reads "Untitled Track". |

The user gets a play and pause button in the middle of the disc, back and forward 10 seconds, the time played and the length, a moving waveform, mute, volume and a repeat switch. Dragging the disc round moves through the track. Keys: Space or K to play or pause, the left and right arrows to move 5 seconds, M to mute.

A "Source:" link to the address is shown underneath. If the file cannot be played the player stays at 0:00.
