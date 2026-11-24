COMPONENT: Video

A video player, as wide as the reply, in a black 16:9 frame. It does not start by itself.

Written as `<Video src="https://..." />`. It holds nothing.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a video file | Required. The file itself (mp4 or webm), not a page that plays one: an address from a video site will not play. |
| title | text | Accepted, but nothing is shown for it. |

Controls appear when the mouse moves over the player: back 10 seconds, play or pause, forward 10 seconds, the time, a bar to move through the video, mute, volume, speed (0.5× to 2×) and full screen. Keys: Space or K to play or pause, the left and right arrows to move 10 seconds, M to mute, F for full screen. On a narrow window some controls are hidden.

A "Source:" link to the address is shown underneath. If the file cannot be played the frame simply stays black.
