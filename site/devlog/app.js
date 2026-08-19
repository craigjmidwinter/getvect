// Katra viewer — Field Notebook × Workbench.
//
// A persistent app shell rendered client-side from data.json (nodes pre-rendered
// to HTML in Go). A hash router swaps the canvas between views:
//   #/overview  — a Future→Now→Past time spine (the landing screen)
//   #/board     — tasks by status (todo · doing · done · cut)
//   #/roadmap   — epics & loose tasks by horizon (now · next · later)
//   #/timeline  — every entry, newest first
//   #/entries · #/decisions · #/reference — the Library lists
//   #/node/<slug>  — one node, full-page reading view
// A bare #<slug> (from a body [[wikilink]] or a backlink) also opens its node.
(function () {
  "use strict";

  var state = {
    data: null,
    hub: null,      // {hub, projects[]} from projects.json — null in a standalone viewer
    bySlug: {},
    children: {},   // epic slug -> [task nodes]
    thread: null,   // active tag filter
    query: "",      // search box text
  };

  var TYPE_ICON = { entry: "◆", task: "▣", epic: "✦", decision: "◈", article: "❋" };

  // ── tiny DOM helpers ──────────────────────────────────────────────────────
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return (s || "").replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function frag() { return document.createDocumentFragment(); }
  function isEntry(e) { return !e.type || e.type === "entry"; }
  function typeOf(e) { return e.type || "entry"; }
  function when(e) { return (e.date || "") + (e.time ? " · " + e.time.slice(0, 5) : ""); }
  // The `katra new` draft template; treated as "no body yet" everywhere.
  var PLACEHOLDER = "Start writing here.";
  var _decoder = document.createElement("div");
  function plainText(html) {
    _decoder.innerHTML = html || "";
    return (_decoder.textContent || "").replace(/\s+/g, " ").trim();
  }
  function isPlaceholderBody(e) { return plainText(e.html) === PLACEHOLDER; }
  function excerpt(e) {
    if (e.summary) return e.summary;
    var t = plainText(e.html);
    if (t === PLACEHOLDER) return "";
    t = t.replace(/^Start writing here\.\s*/, ""); // drop the template preamble
    return t.length > 180 ? t.slice(0, 177) + "…" : t;
  }

  // ── load + index ──────────────────────────────────────────────────────────
  function load() {
    var dataP = fetch("data.json", { cache: "no-store" }).then(function (r) { return r.json(); });
    // Sibling katras power the project switcher. Served by the hub; absent in a
    // standalone single-project viewer — in which case we just render no switcher.
    var projP = fetch("projects.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    Promise.all([dataP, projP])
      .then(function (res) { state.hub = res[1]; boot(res[0]); })
      .catch(function (e) { console.error("katra: failed to load data.json", e); });
  }

  function boot(d) {
    state.data = d;
    if (d.site && d.site.accent) document.documentElement.style.setProperty("--accent", d.site.accent);
    document.title = (d.site && d.site.title) || "Katra";
    state.bySlug = {};
    state.children = {};
    (d.entries || []).forEach(function (e) {
      state.bySlug[e.slug] = e;
      if (e.type === "task" && e.epic) (state.children[e.epic] = state.children[e.epic] || []).push(e);
    });
    window.addEventListener("hashchange", route);
    route();
  }

  function nodes() {
    return (state.data.entries || []).filter(function (e) {
      if (state.thread && (e.tags || []).indexOf(state.thread) < 0) return false;
      if (state.query) {
        var q = state.query.toLowerCase();
        if ((e.title || "").toLowerCase().indexOf(q) < 0 &&
            (excerpt(e) || "").toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  // ── router ────────────────────────────────────────────────────────────────
  var VIEWS = { overview: 1, board: 1, roadmap: 1, timeline: 1, entries: 1, decisions: 1, reference: 1 };

  function parseHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (!h || h === "/") return { view: "overview" };
    if (h.charAt(0) === "/") {
      var seg = h.slice(1).split("/");
      if (seg[0] === "node" && seg[1]) return { view: "node", slug: decodeURIComponent(seg[1]) };
      if (VIEWS[seg[0]]) return { view: seg[0] };
      return { view: "overview" };
    }
    // bare "#slug" — a wikilink / backlink target
    if (state.bySlug[h]) return { view: "node", slug: h };
    return { view: "overview" };
  }

  function route() {
    var r = parseHash();
    renderSide(r);
    var canvas = document.getElementById("canvas");
    canvas.innerHTML = "";
    var view;
    switch (r.view) {
      case "board":     view = viewBoard(); break;
      case "roadmap":   view = viewRoadmap(); break;
      case "timeline":  view = viewList("timeline"); break;
      case "entries":   view = viewList("entries"); break;
      case "decisions": view = viewList("decisions"); break;
      case "reference": view = viewList("reference"); break;
      case "node":      view = viewNode(r.slug); break;
      default:          view = viewOverview();
    }
    canvas.appendChild(view);
    canvas.querySelector(".kv-main") && (canvas.querySelector(".kv-main").scrollTop = 0);
    wireInteractions(canvas);
  }

  function go(hash) { location.hash = hash; }

  // ── sidebar ───────────────────────────────────────────────────────────────
  function renderSide(r) {
    var d = state.data, all = d.entries || [];
    var side = document.getElementById("side");
    side.innerHTML = "";

    var hasSwitcher = !!(state.hub && state.hub.projects && state.hub.projects.length);
    var proj = el("div", "kv-proj" + (hasSwitcher ? " switch" : ""));
    proj.appendChild(el("span", "kv-proj-mark"));
    var pt = el("div"); pt.style.minWidth = "0";
    pt.appendChild(el("div", "kv-proj-name", esc(d.site && d.site.title || "Katra")));
    if (d.site && d.site.description) pt.appendChild(el("div", "kv-proj-desc", esc(d.site.description)));
    proj.appendChild(pt);
    if (hasSwitcher) {
      proj.appendChild(el("span", "kv-proj-caret", "▾"));
      proj.title = "Switch project";
      proj.onclick = function (ev) { ev.stopPropagation(); toggleProjMenu(proj); };
    }
    side.appendChild(proj);

    var counts = {
      board: all.filter(function (e) { return e.type === "task"; }).length,
      entries: all.filter(isEntry).length,
      decisions: all.filter(function (e) { return e.type === "decision"; }).length,
      reference: all.filter(function (e) { return e.type === "article"; }).length,
    };
    var active = r.view;
    // a node view lights up the library group its type belongs to
    if (r.view === "node") {
      var n = state.bySlug[r.slug];
      if (n) active = { entry: "entries", decision: "decisions", article: "reference" }[typeOf(n)] || active;
    }

    side.appendChild(el("div", "kv-navlabel", "Views"));
    [["overview", "◈", "Overview"], ["board", "▤", "Board", counts.board],
     ["roadmap", "↗", "Roadmap"], ["timeline", "≡", "Timeline"]].forEach(function (v) {
      side.appendChild(navLink("/" + v[0], v[1], v[2], v[3], active === v[0]));
    });

    side.appendChild(el("div", "kv-navlabel", "Library"));
    [["entries", "entry", "Entries", counts.entries],
     ["decisions", "decision", "Decisions", counts.decisions],
     ["reference", "article", "Reference", counts.reference]].forEach(function (v) {
      side.appendChild(navLinkDot("/" + v[0], v[1], v[2], v[3], active === v[0]));
    });

    var drafts = all.filter(isEntry).filter(function (e) { return e.draft; }).length;
    var last = lastStamp();
    var foot = el("div", "kv-side-foot");
    foot.innerHTML =
      '<div><span class="mk-amber">●</span> ' + drafts + " draft" + (drafts === 1 ? "" : "s") + " in flight</div>" +
      (last ? '<div><span class="mk-accent">↟</span> last stamp ' + esc(last) + "</div>" : "");
    side.appendChild(foot);
  }

  function navLink(hash, icon, label, count, on) {
    var a = el("a", "kv-navlink" + (on ? " active" : ""));
    a.appendChild(el("span", "ic", esc(icon)));
    a.appendChild(document.createTextNode(" " + label));
    if (count != null) a.appendChild(el("span", "kv-navcount", String(count)));
    a.onclick = function () { go(hash); };
    return a;
  }
  function navLinkDot(hash, type, label, count, on) {
    var a = el("a", "kv-navlink" + (on ? " active" : ""));
    a.appendChild(el("span", "dot dot-" + type));
    a.appendChild(document.createTextNode(" " + label));
    if (count != null) a.appendChild(el("span", "kv-navcount", String(count)));
    a.onclick = function () { go(hash); };
    return a;
  }

  // ── Project switcher — jump to any sibling katra, or up to the hub ─────────
  function toggleProjMenu(anchor) {
    var existing = document.getElementById("kv-projmenu");
    if (existing) { existing.remove(); return; }

    var menu = el("div", "kv-projmenu");
    menu.id = "kv-projmenu";
    menu.onclick = function (ev) { ev.stopPropagation(); }; // let links work, don't re-toggle

    var here = (state.data.site && state.data.site.title) || "";
    (state.hub.projects || []).forEach(function (p) {
      var a = el("a", "kv-projmenu-item" + (p.title === here ? " active" : ""));
      var dot = el("span", "dot");
      dot.style.background = p.accent || "var(--accent)";
      a.appendChild(dot);
      a.appendChild(document.createTextNode(p.title));
      a.href = p.href;
      menu.appendChild(a);
    });
    if (state.hub.hub) {
      var all = el("a", "kv-projmenu-all", "◈ All projects");
      all.href = state.hub.hub;
      menu.appendChild(all);
    }
    anchor.appendChild(menu);

    // Any click elsewhere (or Escape) closes it.
    setTimeout(function () {
      function close() {
        var m = document.getElementById("kv-projmenu");
        if (m) m.remove();
        document.removeEventListener("click", close);
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) { if (e.key === "Escape") close(); }
      document.addEventListener("click", close);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  // ── shared chrome ─────────────────────────────────────────────────────────
  function topbar(title, sub, withNew) {
    var bar = el("div", "kv-top");
    var h = el("div");
    h.appendChild(el("h2", null, esc(title)));
    if (sub) h.appendChild(el("div", "sub", esc(sub)));
    bar.appendChild(h);
    bar.appendChild(searchBox());
    if (withNew) {
      var b = el("button", "kv-btn", "+ New draft");
      b.onclick = function () { alert("New drafts are created from the CLI:  katra new \"Title\""); };
      bar.appendChild(b);
    }
    return bar;
  }
  function searchBox() {
    var box = el("div", "kv-search");
    box.appendChild(document.createTextNode("⌕ "));
    var inp = el("input"); inp.id = "kv-q"; inp.placeholder = "Search the notebook"; inp.value = state.query;
    inp.oninput = function () { state.query = inp.value.trim(); route(); requeryFocus(); };
    box.appendChild(inp);
    box.appendChild(el("span", "kv-kbd", "⌘K"));
    return box;
  }
  function requeryFocus() {
    var q = document.getElementById("kv-q");
    if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  // ==========================================================================
  // OVERVIEW — the time spine
  // ==========================================================================
  function viewOverview() {
    var view = el("div", "kv-view has-rail");
    var main = el("div", "kv-main");
    main.appendChild(topbar("Overview", null, true));

    var ns = nodes();
    var epics = ns.filter(function (e) { return e.type === "epic"; });
    var tasks = ns.filter(function (e) { return e.type === "task"; });
    var entries = ns.filter(isEntry);
    var drafts = entries.filter(function (e) { return e.draft; });
    var logged = entries.filter(function (e) { return !e.draft; })
      .sort(function (a, b) { return cmpDate(b, a); });
    var doing = tasks.filter(function (t) { return t.status === "doing"; });
    var future = epics.filter(function (e) { return e.horizon === "next" || e.horizon === "later"; });

    var spine = el("div", "kv-spine");
    spine.appendChild(el("div", "kv-spine-rail"));

    // FUTURE band — upcoming epics
    if (future.length) {
      var fb = band("FUTURE", null, false, false);
      fb.mark.className = "kv-node-mark epic";
      var pills = el("div", "kv-pillrow");
      future.forEach(function (e) {
        var p = el("div", "kv-pill");
        p.appendChild(el("span", "dot dot-epic"));
        p.appendChild(el("span", "t", esc(e.title)));
        p.appendChild(el("span", "m", esc(e.horizon || "planned") + " · " + childCount(e) + " tasks"));
        p.onclick = function () { go("/node/" + e.slug); };
        pills.appendChild(p);
      });
      fb.body.appendChild(pills);
      spine.appendChild(fb.wrap);
    }

    // NOW band — doing tasks + drafts
    if (doing.length || drafts.length) {
      var nb = band("NOW", "this week", true, false);
      var stack = el("div", "kv-nowstack");
      doing.forEach(function (t, i) {
        var c = el("div", "kv-nowcard");
        var bl = el("div", "badgeline");
        bl.appendChild(statusBadge("task · doing"));
        if (t.epic) {
          var ep = state.bySlug[t.epic];
          bl.appendChild(el("span", "m", "↳ " + esc(ep ? ep.title : t.epic) + (t.effort ? " · " + esc(t.effort) : "")));
        } else if (t.effort) bl.appendChild(el("span", "m", "· " + esc(t.effort)));
        c.appendChild(bl);
        c.appendChild(el("h4", null, esc(t.title)));
        var ex = excerpt(t);
        if (ex && i === 0) c.appendChild(el("p", null, esc(ex)));
        c.onclick = function () { go("/node/" + t.slug); };
        stack.appendChild(c);
      });
      drafts.forEach(function (e) {
        var c = el("div", "kv-nowcard draft");
        c.appendChild(el("div", "draftline", "✎ draft entry · awaiting stamp"));
        c.appendChild(el("h4", null, esc(e.title)));
        c.onclick = function () { go("/node/" + e.slug); };
        stack.appendChild(c);
      });
      nb.body.appendChild(stack);
      spine.appendChild(nb.wrap);
    }

    // PAST band — recent entries
    if (logged.length) {
      var pb = band("PAST", logged[0].date || "", false, false);
      var col = el("div"); col.style.display = "flex"; col.style.flexDirection = "column"; col.style.gap = "13px";
      logged.slice(0, 6).forEach(function (e) { col.appendChild(pastEntry(e)); });
      pb.body.appendChild(col);
      spine.appendChild(pb.wrap);
    }

    if (!future.length && !doing.length && !drafts.length && !logged.length) {
      main.appendChild(emptyState());
    } else {
      main.appendChild(spine);
    }
    view.appendChild(main);
    view.appendChild(overviewRail(doing, drafts, logged, epics, entries));
    return view;
  }

  function band(label, sub, now, epic) {
    var wrap = el("div", "kv-band");
    var lab = el("div", "kv-band-label" + (now ? " now" : ""));
    lab.appendChild(el("div", "k", esc(label)));
    if (sub) lab.appendChild(el("div", "when", esc(sub)));
    wrap.appendChild(lab);
    var body = el("div", "kv-band-body");
    var mark = el("span", "kv-node-mark" + (now ? " now" : ""));
    body.appendChild(mark);
    wrap.appendChild(body);
    return { wrap: wrap, body: body, mark: mark };
  }

  function pastEntry(e) {
    var c = el("article", "kv-entrycard" + (e.cover ? "" : " tight"));
    c.onclick = function () { go("/node/" + e.slug); };
    if (e.cover) {
      var cov = el("div", "cover"); cov.style.backgroundImage = "url('" + e.cover + "')";
      c.appendChild(cov);
    }
    var pad = el("div", "pad");
    var tr = el("div", "titlerow");
    tr.appendChild(el("h3", null, esc(e.title)));
    tr.appendChild(el("span", "date", esc(e.date || "")));
    pad.appendChild(tr);
    var ex = excerpt(e);
    if (ex) pad.appendChild(el("p", "excerpt", esc(ex)));
    pad.appendChild(commitLine(e));
    c.appendChild(pad);
    return c;
  }

  function commitLine(e) {
    var line = el("div", "kv-commitline");
    if (e.hashes && e.hashes.length) line.innerHTML = "commit <b>" + e.hashes.map(esc).join("</b> <b>") + "</b>";
    if (e.stat) {
      line.appendChild(el("span", "add", "+" + e.stat.a));
      line.appendChild(el("span", "del", "−" + e.stat.d));
    }
    return line;
  }

  function overviewRail(doing, drafts, logged, epics, entries) {
    var rail = el("div", "kv-rail");
    var shipped = entries.filter(function (e) { return !e.draft && withinDays(e.date, 7); }).length;

    var grid = el("div", "kv-statgrid");
    grid.appendChild(stat(doing.length, "doing", "amber"));
    grid.appendChild(stat(shipped, "shipped / 7d", "green"));
    rail.appendChild(grid);

    rail.appendChild(el("div", "kv-railhead", "The spine"));
    var sp = el("div", "kv-raillist kv-rail-block");
    sp.appendChild(railLine("dot-epic", "Future · " + epics.filter(function (e) { return e.horizon === "next" || e.horizon === "later"; }).length + " epics", "/roadmap"));
    sp.appendChild(railLine("", "Now · " + doing.length + " doing, " + drafts.length + " draft", "/board", true));
    sp.appendChild(railLine("dot-entry", "Past · " + logged.length + " entries", "/timeline"));
    rail.appendChild(sp);

    var decisions = (state.data.entries || []).filter(function (e) { return e.type === "decision"; });
    if (decisions.length) {
      rail.appendChild(el("div", "kv-railhead", "Load-bearing choices"));
      var ch = el("div", "kv-choices kv-rail-block");
      decisions.slice(0, 4).forEach(function (d) {
        var superseded = d.status === "superseded" || d.status === "deprecated";
        var a = el("div", "kv-choice" + (superseded ? " superseded" : ""),
          esc(d.title) + (superseded ? ' <span style="font-size:10px;">(' + esc(d.status) + ")</span>" : ""));
        a.onclick = function () { go("/node/" + d.slug); };
        ch.appendChild(a);
      });
      rail.appendChild(ch);
    }

    var threads = tagCounts();
    if (threads.length) {
      rail.appendChild(el("div", "kv-railhead", "Threads"));
      var tw = el("div", "kv-threads");
      threads.forEach(function (t) {
        var s = el("span", "kv-thread" + (state.thread === t.name ? " active" : ""), esc(t.name) + " " + t.n);
        s.onclick = function () { state.thread = state.thread === t.name ? null : t.name; route(); };
        tw.appendChild(s);
      });
      rail.appendChild(tw);
    }
    return rail;
  }

  function stat(n, label, cls) {
    var s = el("div", "kv-stat " + (cls || ""));
    s.appendChild(el("div", "n", String(n)));
    s.appendChild(el("div", "l", esc(label)));
    return s;
  }
  function railLine(dotCls, label, hash, now) {
    var a = el("a"); a.style.color = now ? "var(--accent)" : "";
    if (now) a.style.fontWeight = "600";
    var dot = el("span", "dot"); dot.style.background = now ? "var(--accent)" : "";
    if (dotCls) dot.className = "dot " + dotCls;
    a.appendChild(dot);
    a.appendChild(document.createTextNode(" " + label));
    a.onclick = function () { go(hash); };
    return a;
  }
  function statusBadge(text) { return el("span", "kv-badge st-doing", esc(text)); }

  // ==========================================================================
  // BOARD — tasks by status
  // ==========================================================================
  function viewBoard() {
    var view = el("div", "kv-view full");
    var main = el("div", "kv-main");

    var tasks = (state.data.entries || []).filter(function (e) { return e.type === "task"; });
    if (state.query) {
      var q = state.query.toLowerCase();
      tasks = tasks.filter(function (t) { return (t.title || "").toLowerCase().indexOf(q) >= 0; });
    }
    // epic filter chips
    var epics = (state.data.entries || []).filter(function (e) { return e.type === "epic"; });
    var bar = el("div", "kv-filterbar");
    bar.appendChild(el("h2", null, "Board"));
    var chips = el("div", "kv-chips");
    chips.appendChild(chip("all epics", state.thread === null, function () { state.thread = null; route(); }));
    epics.forEach(function (e) {
      chips.appendChild(chip(e.title, state.thread === "epic:" + e.slug, function () {
        state.thread = state.thread === "epic:" + e.slug ? null : "epic:" + e.slug; route();
      }));
    });
    bar.appendChild(chips);
    bar.appendChild(el("span", "kv-groupby", "group: status ▾"));
    main.appendChild(bar);

    if (state.thread && state.thread.indexOf("epic:") === 0) {
      var es = state.thread.slice(5);
      tasks = tasks.filter(function (t) { return t.epic === es; });
    }

    var cols = ["todo", "doing", "done"];
    if (tasks.some(function (t) { return t.status === "cut"; })) cols.push("cut");
    var grid = el("div", "kv-cols board");
    cols.forEach(function (status) {
      var ct = tasks.filter(function (t) { return (t.status || "todo") === status; });
      var col = el("div", "kv-col " + status);
      var head = el("div", "kv-colhead");
      head.appendChild(el("span", "nm", status));
      head.appendChild(el("span", null, String(ct.length)));
      col.appendChild(head);
      var body = el("div", "kv-colbody");
      ct.forEach(function (t) { body.appendChild(taskCard(t, status)); });
      col.appendChild(body);
      grid.appendChild(col);
    });
    main.appendChild(grid);
    view.appendChild(main);
    return view;
  }

  function chip(label, on, fn) {
    var c = el("span", "kv-chip" + (on ? " active" : ""), esc(label));
    c.onclick = fn;
    return c;
  }

  function taskCard(t, status) {
    var c = el("div", "kv-task " + status);
    c.onclick = function () { go("/node/" + t.slug); };
    c.appendChild(el("div", "kv-task-title", esc(t.title)));
    if (status === "done" && t.entry) {
      c.appendChild(el("div", "kv-task-meta", '<span class="entry">→ entry ' + esc(t.entry) + "</span>"));
    } else if (status === "cut") {
      if (t.summary) c.appendChild(el("div", "kv-task-note", esc(t.summary)));
    } else {
      var meta = el("div", "kv-task-meta");
      if (t.effort) meta.appendChild(el("span", "kv-badge", esc(t.effort)));
      if (t.epic) {
        var ep = state.bySlug[t.epic];
        meta.appendChild(el("span", "epic", "↳ " + esc(ep ? ep.title : t.epic)));
      } else meta.appendChild(el("span", null, "unassigned"));
      c.appendChild(meta);
    }
    return c;
  }

  // ==========================================================================
  // ROADMAP — epics & loose tasks by horizon
  // ==========================================================================
  function viewRoadmap() {
    var view = el("div", "kv-view full");
    var main = el("div", "kv-main");

    var epics = (state.data.entries || []).filter(function (e) { return e.type === "epic"; });
    var tasks = (state.data.entries || []).filter(function (e) { return e.type === "task"; });
    var loose = tasks.filter(function (t) { return !t.epic; });

    var bar = el("div", "kv-filterbar");
    bar.appendChild(el("h2", null, "Roadmap"));
    bar.appendChild(el("span", "kv-groupby",
      epics.length + " epic" + (epics.length === 1 ? "" : "s") + " · " + loose.length + " loose task" + (loose.length === 1 ? "" : "s")));
    main.appendChild(bar);

    var order = ["now", "next", "later"];
    var bucket = function (h) { return order.indexOf(h) >= 0 ? h : "unscheduled"; };
    var cols = order.slice();
    if (epics.concat(loose).some(function (n) { return bucket(n.horizon) === "unscheduled"; })) cols.push("unscheduled");

    var grid = el("div", "kv-cols roadmap");
    cols.forEach(function (h) {
      var wrap = el("div");
      var head = el("div", "kv-horizon-head " + h);
      head.appendChild(el("span", "dot"));
      head.appendChild(el("span", "k", h));
      wrap.appendChild(head);
      var body = el("div", "kv-horizon-col");
      epics.filter(function (e) { return bucket(e.horizon) === h; }).forEach(function (e) { body.appendChild(epicCard(e)); });
      loose.filter(function (t) { return bucket(t.horizon) === h; }).forEach(function (t) { body.appendChild(looseCard(t)); });
      wrap.appendChild(body);
      grid.appendChild(wrap);
    });
    main.appendChild(grid);
    view.appendChild(main);
    return view;
  }

  function epicCard(e) {
    var c = el("div", "kv-epic");
    c.onclick = function () { go("/node/" + e.slug); };
    var tr = el("div", "titlerow");
    tr.appendChild(el("span", "dot dot-epic"));
    tr.appendChild(el("h3", null, esc(e.title)));
    c.appendChild(tr);

    var kids = state.children[e.slug] || [];
    var done = kids.filter(function (k) { return k.status === "done"; }).length;
    var statusText = e.status || e.rollup || (kids.length ? "active" : "planned");
    c.appendChild(el("div", "roll", "epic · " + esc(statusText) + " · " + done + "/" + kids.length + " done"));

    var pct = kids.length ? Math.round((done / kids.length) * 100) : 0;
    var prog = el("div", "kv-progress");
    var span = el("span"); span.style.width = pct + "%"; prog.appendChild(span);
    c.appendChild(prog);

    if (kids.length) {
      var ul = el("ul", "kv-epic-tasks");
      kids.slice(0, 4).forEach(function (k) {
        var st = k.status || "todo";
        var li = el("li", st === "doing" ? "doing" : st === "done" ? "done" : "");
        li.appendChild(el("span", "mk"));
        li.appendChild(document.createTextNode(k.title));
        ul.appendChild(li);
      });
      c.appendChild(ul);
    }
    return c;
  }

  function looseCard(t) {
    var c = el("div", "kv-loose");
    c.onclick = function () { go("/node/" + t.slug); };
    c.appendChild(el("div", "k", "loose task · " + esc(t.status || "todo")));
    c.appendChild(el("div", "t", esc(t.title)));
    return c;
  }

  // ==========================================================================
  // LIBRARY LISTS (timeline / entries / decisions / reference)
  // ==========================================================================
  function viewList(kind) {
    var view = el("div", "kv-view full");
    var main = el("div", "kv-main");
    var meta = {
      timeline:  { title: "Timeline", sub: "every entry, newest first", type: "entry" },
      entries:   { title: "Entries",  sub: "logged work, newest first",  type: "entry" },
      decisions: { title: "Decisions", sub: "what we chose and why, until when", type: "decision" },
      reference: { title: "Reference", sub: "articles — how things work", type: "article" },
    }[kind];
    main.appendChild(topbar(meta.title, meta.sub, kind === "entries" || kind === "timeline"));

    var list = nodes().filter(function (e) {
      if (meta.type === "entry") return isEntry(e);
      return e.type === meta.type;
    }).sort(function (a, b) { return cmpDate(b, a); });

    if (!list.length) { main.appendChild(emptyState()); view.appendChild(main); return view; }

    var wrap = el("div", "kv-list");
    list.forEach(function (e) { wrap.appendChild(listRow(e, kind)); });
    main.appendChild(wrap);
    view.appendChild(main);
    return view;
  }

  function listRow(e, kind) {
    var superseded = e.status === "superseded" || e.status === "deprecated";
    var row = el("article", "kv-listrow" +
      (kind === "decisions" ? " kv-decisionrow" + (superseded ? " " + e.status : "") : ""));
    row.onclick = function () { go("/node/" + e.slug); };
    row.appendChild(el("span", "dot dot-" + typeOf(e)));
    var body = el("div", "body");
    var h = el("h3", null, esc(e.title));
    body.appendChild(h);
    var ex = excerpt(e);
    if (ex) body.appendChild(el("p", "excerpt", esc(ex)));
    var meta = el("div", "meta");
    if (e.status) meta.appendChild(el("span", "kv-badge st-" + e.status, esc(e.status)));
    if (e.hashes && e.hashes.length) meta.appendChild(el("span", null, "commit <b>" + esc(e.hashes[0]) + "</b>"));
    if (e.stat) meta.appendChild(el("span", null, "+" + e.stat.a + " −" + e.stat.d));
    (e.tags || []).slice(0, 4).forEach(function (t) { meta.appendChild(el("span", null, esc(t))); });
    if (meta.childNodes.length) body.appendChild(meta);
    row.appendChild(body);
    row.appendChild(el("span", "when", esc(e.date || "")));
    return row;
  }

  // ==========================================================================
  // READING A NODE — one node, full page
  // ==========================================================================
  function viewNode(slug) {
    var e = state.bySlug[slug];
    if (!e) {
      var v = el("div", "kv-view full");
      var m = el("div", "kv-main"); m.appendChild(emptyState("Nothing here — that node doesn't exist."));
      v.appendChild(m); return v;
    }
    var view = el("div", "kv-view has-rail");
    var main = el("div", "kv-main");

    var type = typeOf(e);
    var libHash = { entry: "/entries", decision: "/decisions", article: "/reference" }[type] || "/timeline";
    var libName = { entry: "Entries", decision: "Decisions", article: "Reference", task: "Board", epic: "Roadmap" }[type] || "Library";
    if (type === "task") libHash = "/board";
    if (type === "epic") libHash = "/roadmap";

    var crumbs = el("div", "kv-crumbs");
    var back = el("a", null, esc(libName)); back.onclick = function () { go(libHash); };
    crumbs.appendChild(back);
    crumbs.appendChild(document.createTextNode(" / "));
    crumbs.appendChild(el("span", "kind", esc(type)));
    crumbs.appendChild(prevNext(e, type));
    main.appendChild(crumbs);

    var read = el("article", "kv-read");
    var kick = el("div", "kv-read-kicker");
    kick.appendChild(el("span", "dot dot-" + type));
    kick.appendChild(el("span", "k", type.toUpperCase()));
    kick.appendChild(el("span", "muted", "· " + (e.draft ? "draft" : statusWord(e))));
    read.appendChild(kick);

    read.appendChild(el("h1", null, esc(e.title)));

    var meta = el("div", "kv-read-meta");
    meta.innerHTML = esc(when(e));
    if (e.hashes && e.hashes.length) {
      meta.appendChild(el("span", "sep", "|"));
      meta.appendChild(el("span", null, "commit <b>" + e.hashes.map(esc).join("</b> <b>") + "</b>"));
    }
    if (e.stat) {
      meta.appendChild(el("span", "add", "+" + e.stat.a));
      meta.appendChild(el("span", "del", "−" + e.stat.d));
    }
    read.appendChild(meta);

    if (e.tags && e.tags.length) {
      var tags = el("div", "kv-read-tags");
      e.tags.forEach(function (t) { tags.appendChild(el("span", "kv-read-tag", esc(t))); });
      read.appendChild(tags);
    }

    if (e.draft) read.appendChild(el("div", "kv-draft-banner", "✎ Draft entry — committed work in flight, awaiting a commit stamp."));

    if (e.cover) {
      var cov = el("div", "kv-read-cover"); cov.style.backgroundImage = "url('" + e.cover + "')";
      read.appendChild(cov);
    }

    var body = el("div", "kv-body");
    if (isPlaceholderBody(e)) {
      body.innerHTML = '<p style="color:var(--ink-faint);font-style:italic">No notes written yet.</p>';
    } else {
      body.innerHTML = e.html || "";
    }
    rewriteWikilinks(body);
    read.appendChild(body);

    read.appendChild(readFoot(e));
    main.appendChild(read);
    view.appendChild(main);
    view.appendChild(nodeRail(e, body));
    return view;
  }

  function prevNext(e, type) {
    var sibs = (state.data.entries || []).filter(function (n) { return typeOf(n) === type; })
      .sort(function (a, b) { return cmpDate(b, a); });
    var i = sibs.findIndex(function (n) { return n.slug === e.slug; });
    var nav = el("span", "nav");
    if (i > 0) { var p = el("a", null, "← prev"); p.onclick = function () { go("/node/" + sibs[i - 1].slug); }; nav.appendChild(p); }
    if (i >= 0 && i < sibs.length - 1) {
      if (nav.childNodes.length) nav.appendChild(document.createTextNode(" · "));
      var nx = el("a", null, "next →"); nx.onclick = function () { go("/node/" + sibs[i + 1].slug); }; nav.appendChild(nx);
    }
    return nav;
  }

  function readFoot(e) {
    var closedTask = (state.data.entries || []).find(function (n) { return n.type === "task" && n.entry === e.slug; });
    if (!(e.hashes && e.hashes.length) && !e.stat && !closedTask) return el("span");
    var f = el("div", "kv-read-foot");
    if (e.hashes && e.hashes.length) f.appendChild(el("span", null, "commit <b>" + e.hashes.map(esc).join("</b> <b>") + "</b>"));
    if (e.stat) {
      f.appendChild(el("span", "add", (e.stat.f ? e.stat.f + " files · " : "") + "+" + e.stat.a));
      f.appendChild(el("span", "del", "−" + e.stat.d));
    }
    if (closedTask) f.appendChild(el("span", "closed", "✓ closed task: " + esc(closedTask.slug)));
    return f;
  }

  function nodeRail(e, body) {
    var rail = el("div", "kv-rail");

    // In this entry — TOC from h2/h3
    var heads = body.querySelectorAll("h2[id], h3[id]");
    if (heads.length) {
      rail.appendChild(el("div", "kv-railhead", "In this " + typeOf(e)));
      var toc = el("div", "kv-toc kv-rail-block");
      heads.forEach(function (h) {
        var a = el("a", h.tagName === "H3" ? "sub" : null, esc(h.textContent));
        if (h.tagName === "H3") a.style.paddingLeft = "10px";
        a.onclick = function () { h.scrollIntoView({ behavior: "smooth", block: "start" }); };
        toc.appendChild(a);
      });
      rail.appendChild(toc);
    }

    var links = (e.links || []).concat(e.backlinks || []);
    var seen = {};
    var decisions = links.filter(function (r) {
      if (r.type !== "decision" || seen[r.slug]) return false; seen[r.slug] = 1; return true;
    });
    if (decisions.length) {
      rail.appendChild(el("div", "kv-railhead", "Decisions promoted here"));
      var block = el("div", "kv-rail-block");
      decisions.forEach(function (r) {
        var card = el("a", "kv-railcard decision");
        card.appendChild(el("div", "t", esc(r.title || r.slug)));
        card.appendChild(el("div", "m", "decision"));
        card.onclick = function () { go("/node/" + r.slug); };
        block.appendChild(card);
      });
      rail.appendChild(block);
    }

    var linkedFrom = (e.backlinks || []).filter(function (r) { return r.type !== "decision"; });
    if (linkedFrom.length) {
      rail.appendChild(el("div", "kv-railhead", "Linked from"));
      var lb = el("div", "kv-rail-block");
      linkedFrom.forEach(function (r) {
        var row = el("a", "kv-linkrow");
        row.appendChild(el("span", "dot dot-" + (r.type || "entry")));
        row.appendChild(el("span", "t", esc(r.title || r.slug)));
        row.appendChild(el("span", "kind", esc(r.type || "node")));
        row.onclick = function () { go("/node/" + r.slug); };
        lb.appendChild(row);
      });
      rail.appendChild(lb);
    }
    return rail;
  }

  // Body [[wikilinks]] arrive as <a href="#slug">; route them through the node view.
  function rewriteWikilinks(body) {
    body.querySelectorAll("a.dl-wikilink").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) !== "#") return;
      var slug = href.slice(1);
      a.onclick = function (ev) { ev.preventDefault(); go(state.bySlug[slug] ? "/node/" + slug : "#" + slug); };
    });
  }

  // ── derived helpers ───────────────────────────────────────────────────────
  function childCount(e) { return (state.children[e.slug] || []).length; }
  function statusWord(e) { return e.status || (isEntry(e) ? "logged" : ""); }
  function cmpDate(a, b) {
    var ka = (a.date || "") + (a.time || ""), kb = (b.date || "") + (b.time || "");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  function lastStamp() {
    var logged = (state.data.entries || []).filter(function (e) { return isEntry(e) && !e.draft && e.date; })
      .sort(function (a, b) { return cmpDate(b, a); });
    if (!logged.length) return "";
    return relDate(logged[0].date, logged[0].time);
  }
  function withinDays(dateStr, days) {
    if (!dateStr) return false;
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return false;
    return (Date.now() - d.getTime()) <= days * 864e5 && d.getTime() <= Date.now() + 864e5;
  }
  function relDate(dateStr, timeStr) {
    var d = new Date(dateStr + "T" + (timeStr || "00:00:00"));
    if (isNaN(d)) return dateStr;
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var day = Math.round(hrs / 24);
    if (day < 30) return day + "d ago";
    return dateStr;
  }
  function tagCounts() {
    var counts = {};
    (state.data.entries || []).forEach(function (e) { (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (name) { return { name: name, n: counts[name] }; });
  }
  function emptyState(msg) {
    var e = el("div", "kv-empty");
    e.innerHTML = msg ? esc(msg) : 'Nothing here yet. Run <code>katra new "Title"</code> to start.';
    return e;
  }

  // ── interactions: lightbox + compare slider + ⌘K ──────────────────────────
  function wireInteractions(root) {
    root.querySelectorAll("[data-dl-lightbox], .kv-body img").forEach(function (img) {
      if (img.closest(".dl-compare")) return;
      img.onclick = function () { openLightbox(img.src); };
    });
    root.querySelectorAll("[data-dl-compare]").forEach(wireCompare);
  }
  function wireCompare(fig) {
    var range = fig.querySelector(".dl-compare-range");
    var before = fig.querySelector(".dl-compare-before");
    var handle = fig.querySelector(".dl-compare-handle");
    if (!range) return;
    function set(v) { before.style.width = v + "%"; handle.style.left = v + "%"; }
    range.addEventListener("input", function () { set(range.value); });
    set(range.value);
  }
  function openLightbox(src) {
    var lb = document.getElementById("lightbox");
    document.getElementById("lightbox-img").src = src; lb.hidden = false;
  }
  function closeLightbox() {
    document.getElementById("lightbox").hidden = true; document.getElementById("lightbox-img").src = "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("lightbox").onclick = closeLightbox;
    document.getElementById("lightbox-close").onclick = closeLightbox;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeLightbox();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        var q = document.getElementById("kv-q"); if (q) q.focus();
      }
    });
    load();
  });
})();
