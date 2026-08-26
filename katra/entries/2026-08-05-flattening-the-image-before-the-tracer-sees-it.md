---
publish: true
title: Flattening the image before the tracer sees it
date: "2026-08-05"
time: "10:03:35"
tags:
    - enhance
    - ai
hashes:
    - 474f116
    - 9d972ae
    - 7441aa6
    - ad2b160
    - e20a6c0
    - 77498f1
    - ce03d87
stat:
    f: 19
    a: 2245
    d: 42
---

> **The prompt experiment that proved it:** "convert into a flat vector graphic" beats
> describing the operations one by one — the style name carries the whole contract.

![A generative pass re-illustrates the input on the user's own key, and the tracer takes it apart in 629 ms — 9 colours, 8 layers, 50 KB, transparent background intact](media/enhance-payoff.png)

Soft shading is the case a tracer cannot win. Given an airbrushed gradient it has to
decide where one colour stops, and every choice is wrong somewhere — hard bands where
the artist wanted a blend, or a hundred slivers where they wanted one shape. No amount
of median filtering or despeckling fixes it, because what the tracer needs was never
in the image.

What fixes it is changing the input. A generative image-to-image pass can repaint the
picture as flat art first — background removed, shading collapsed into bands, outlines
redrawn at even weight — and the tracer then gets the kind of image it is actually good
at. That is what AI Enhance does, on a key the user brings.

One call to gemini-2.5-flash-image does it in about eight seconds. The prompt matters
more than expected, and Craig called the winning move: don't describe the operations,
name the *artifact* — "convert this image into a flat vector graphic, exactly as it
would look exported from an SVG illustration tool." The style label smuggles in the
whole contract (flat fills, hard boundaries, uniform outlines) more reliably than
listing them. An A/B against the operation-list prompt wasn't close.

The feature shipped the same day: a provider abstraction with the key encrypted in the
main process (there is no IPC that returns it — the renderer only gets booleans), the
privacy trade printed in body text right at the toggle, typed failures that fall back
to the un-enhanced image, and a stubbed provider so all seven new specs run offline.
A real-key run answered the one question the stub could not: the model returns RGB even
when asked for transparency, so the app's never-fake-alpha fallback is permanent
behaviour, and local background removal (issue #1) earns its keep even for people using
the cloud path.

```note
The classical side didn't sit idle. Measuring against a flattened canvas exposed that
the Smart-AA fold was crowning the biggest histogram peak as each merged band's colour.
Re-centring survivors on the coverage-weighted mean of what they absorbed warmed the
muddy face by half its error — and improved the fox too.
```

The payoff frame is the screenshot above: a generative flatten running on the user's
own key, and the trace it feeds coming back in 629 ms looking like it belongs beside
the original.
