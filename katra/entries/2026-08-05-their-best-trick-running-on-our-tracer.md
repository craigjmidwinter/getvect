---
title: Their best trick, running on our tracer
date: "2026-08-05"
time: "10:03:35"
tags:
    - enhance
    - ai
    - reverse-engineering
hashes:
    - 2cc4bbd
    - 28796e9
    - 82ed06e
    - c69f7c4
    - 18b427c
    - 3ee5a1d
    - 4e359f5
stat:
    f: 19
    a: 2245
    d: 42
---

> **The prompt experiment that proved it:** "convert into a flat vector graphic" beats
> describing the operations one by one — the style name carries the whole contract.
> (The screenshot that showed this has been removed along with the third-party artwork
> it was demonstrated on.)

![The payoff frame: Gemini re-illustrates the input with Craig's own key, our tracer takes it apart in 629 ms — 9 colours, 8 layers, 50 KB, transparent background intact](media/enhance-payoff.png)

The question that started the day was "how come our output looks so much worse than
vectorizer on the local artwork?" — and the answer turned out to be that we'd been
comparing our tracer against their *illustrator*. Extracting the site's input canvas
settled it: "Enhance image with AI" is a generative image-to-image pass. The upload
comes back repainted — background deleted, airbrushed shading flattened to bands,
outlines redrawn — and their tracer traces that. The moat was never the
vectorization. It was the model in front of it.

Once you know that, the replication path is obvious and slightly cheeky: let users
bring their own model. One API call to gemini-2.5-flash-image reproduced the
behaviour in about eight seconds. The prompt matters more than expected, and
Craig called the winning move: don't describe the operations, name the *artifact* —
"convert this image into a flat vector graphic, exactly as it would look exported
from an SVG illustration tool." The style label smuggles in the whole contract
(flat fills, hard boundaries, uniform outlines) more reliably than listing them.
An A/B against the operation-list prompt wasn't close.

The feature shipped the same day: provider abstraction with the key encrypted in
the main process (there is no IPC that returns it — the renderer gets booleans),
the privacy trade printed in body text at the toggle, typed failures that fall back
to the un-enhanced image, and a stubbed provider so all seven new specs run
offline. A real-key run answered the one question the stub couldn't: Gemini
returns RGB even when you ask for transparency, so the app's
never-fake-alpha fallback is permanent behaviour, and local background removal
(issue #1) earns its keep even for cloud users.

```note
The classical side didn't sit idle: measuring against the reference product's enhanced
canvas exposed that our Smart-AA fold crowned the biggest histogram peak as each
merged band's colour. Re-centring survivors on the coverage-weighted mean of what
they absorbed warmed the muddy face by half its error — and improved the fox too.
```

The payoff frame is the screenshot above: the reference product's signature
feature, reverse-engineered before lunch, running inside our own app on the
user's own key — and the trace it feeds comes back in 629 ms looking like it
belongs next to the original.
