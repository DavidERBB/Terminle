const MAX_TRIES = 3;
const START = Date.UTC(2026, 11, 19);
const KEY = "terminle-save";

const $ = (id) => document.getElementById(id);

function getDaysSinceStart() {
    const n = new Date();
    const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.max(0, Math.round((today - START) / 86400000));
}

// Save and load progress
function defaultSave() {
    return { days: {}, streak: 0, lastFinishedDay: null };
}

function loadSave() {
    try {
        const data = JSON.parse(localStorage.getItem(KEY));
        if (!data || typeof data !== "object" || Array.isArray(data)) return defaultSave();
        if (!data.days || typeof data.days !== "object" || Array.isArray(data.days)) data.days = {};
        if (!Number.isFinite(data.streak) || data.streak < 0) data.streak = 0;
        if (data.lastFinishedDay != null && !Number.isInteger(data.lastFinishedDay)) data.lastFinishedDay = null;
        return data;
    } catch {
        return defaultSave();
    }
}

function writeSave() {
    try {
        localStorage.setItem(KEY, JSON.stringify(save));
    } catch {}
}

function resetSave() {
    localStorage.removeItem(KEY);
    location.reload();
}

function dayRecord(save, day) {
    const record = save.days[day];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        save.days[day] = { results: [], tries: 0, wrong: [] };
        return save.days[day];
    }
    if (!Array.isArray(record.results)) record.results = [];
    if (!Array.isArray(record.wrong)) record.wrong = [];
    if (!Number.isInteger(record.tries) || record.tries < 0) record.tries = 0;
    return record;
}

const day = getDaysSinceStart();
const save = loadSave();
const today = dayRecord(save, day);

let puzzles = [];
let locked = false;
let shareTimer = 0;

// ' and " are the same answer. Spaces between values stay, so 20 0 is not 200.
// Spaces beside brackets, commas and colons do not count. alternatives lists other spellings.
function normalize(str) {
    return String(str ?? "")
        .replace(/[\u2018\u2019\u201A\u201B\uFF07]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\uFF02]/g, '"')
        .replace(/"/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\s*([\[\]{}(),:;])\s*/g, "$1");
}

function answersOf(puzzle) {
    const extra = Array.isArray(puzzle.alternatives) ? puzzle.alternatives : [];
    return [puzzle.answer, ...extra].filter((item) => typeof item === "string" && item.trim());
}

function isCorrect(guess, puzzle) {
    const typed = normalize(guess);
    return answersOf(puzzle).some((answer) => normalize(answer) === typed);
}

function visibleStreak() {
    if (save.lastFinishedDay === day || save.lastFinishedDay === day - 1) return save.streak;
    return 0;
}

function updateStreak() {
    if (save.lastFinishedDay === day) return;
    save.streak = save.lastFinishedDay === day - 1 ? save.streak + 1 : 1;
    save.lastFinishedDay = day;
}

function pageUrl() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return "";
    const url = new URL(location.href);
    url.hash = "";
    url.search = "";
    if (url.pathname.endsWith("/index.html")) {
        url.pathname = url.pathname.slice(0, -"index.html".length);
    }
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
}

function shareText() {
    const grid = today.results.map((r) => (r.correct ? "🟩" : "🟥")).join("");
    const score = today.results.filter((r) => r.correct).length;
    const lines = [
        `Terminle #${day + 1}`,
        `${grid} ${score}/${today.results.length}`,
        `🔥 Streak: ${save.streak}`,
    ];
    const url = pageUrl();
    if (url) lines.push("", url);
    return lines.join("\n");
}

function setMeta(attr, key, content) {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, key);
        document.head.append(el);
    }
    el.content = content;
}

// Crawlers that run JavaScript (Google) see the address the page was opened on.
// Discord, X and WhatsApp do not run JavaScript: they read the tags in index.html.
function publishMeta() {
    const url = pageUrl();
    if (!url) return;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement("link");
        canonical.rel = "canonical";
        document.head.append(canonical);
    }
    canonical.href = url;
    const image = new URL("og.png", url).href;
    setMeta("property", "og:url", url);
    setMeta("property", "og:image", image);
    setMeta("name", "twitter:url", url);
    setMeta("name", "twitter:image", image);

    const data = document.querySelector('script[type="application/ld+json"]');
    if (!data) return;
    try {
        const json = JSON.parse(data.textContent);
        json.url = url;
        data.textContent = JSON.stringify(json);
    } catch {}
}

// Syntax highlighting
const EXT = {
    javascript: "js", python: "py", go: "go", c: "c", rust: "rs",
    java: "java", "c#": "cs", ruby: "rb", php: "php", swift: "swift",
    kotlin: "kt", typescript: "ts", bash: "sh", lua: "lua", sqlite: "sql",
    elixir: "ex", scala: "scala", haskell: "hs", dart: "dart", perl: "pl", r: "r",
};

const COMMENT_SLASH = /\/\/.*|\/\*.*?\*\//.source;
const COMMENT_HASH = /#.*/.source;
const COMMENT_DASH = /--.*/.source;
const COMMENT_PHP = /#.*|\/\/.*|\/\*.*?\*\//.source;
const STR_DOUBLE = /"(?:\\.|[^"\\])*"/.source;
const STR_SINGLE = /'(?:\\.|[^'\\])*'/.source;
const STR_BACKTICK = /`(?:\\.|[^`\\])*`/.source;
const CHAR = /'(?:\\.|[^'\\])'/.source; // one character, so Rust lifetimes ('a) are left alone

// Groups: 1 = comment, 2 = string, 3 = number, 4 = word
function tokenRegex(comment, ...strings) {
    return new RegExp(
        `(${comment})|(${strings.join("|")})|(\\b0x[0-9a-f]+\\b|\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`,
        "g"
    );
}

const words = (s) => new Set(s.split(" "));

const SYNTAX = {
    javascript: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE, STR_BACKTICK),
        keywords: words("const let var function return if else for while do class extends new this typeof instanceof await async delete of in void throw try catch finally break continue switch case default yield import export from static super true false null undefined"),
        builtins: words("console Math Promise Object Array Number String Boolean Symbol JSON Date Map Set NaN Infinity parseInt parseFloat setTimeout setInterval"),
    },
    python: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("def return if elif else for while in not and or is class import from as lambda pass break continue try except finally raise with yield True False None"),
        builtins: words("print len range int str float bool list dict set tuple type sum min max sorted enumerate zip map filter abs round"),
    },
    go: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_BACKTICK, CHAR),
        keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil"),
        builtins: words("fmt int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error len cap append make new copy delete panic recover"),
    },
    c: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, CHAR),
        keywords: words("if else for while do switch case default break continue return goto typedef struct union enum sizeof static extern const volatile register inline unsigned signed true false NULL"),
        builtins: words("int char float double void long short size_t bool printf scanf malloc free strlen"),
    },
    rust: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, CHAR),
        keywords: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
        builtins: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Some None Ok Err Result Box"),
    },
    java: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while do switch case default break continue return new class interface extends implements public private protected static final void int long double float boolean char byte short true false null this super try catch finally throw import package var"),
        builtins: words("System String Integer Math StringBuilder"),
    },
    "c#": {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while do switch case default break continue return new class interface public private protected static void int long double float bool char byte short true false null this var string using namespace"),
        builtins: words("Console string String Math Enumerable"),
    },
    ruby: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("def end if elsif else unless for while do class module return yield true false nil self begin rescue ensure and or not"),
        builtins: words("puts print p gets require"),
    },
    php: {
        regex: tokenRegex(COMMENT_PHP, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else elseif for while do switch case default break continue return function class public private protected static new echo print true false null and or"),
        builtins: words("strlen strrev strtoupper count in_array"),
    },
    swift: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while switch case default break continue return func let var struct class enum true false nil self guard import in"),
        builtins: words("print String Int Array"),
    },
    kotlin: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while do when break continue return fun val var class object interface true false null this in is"),
        builtins: words("println listOf mutableMapOf"),
    },
    typescript: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE, STR_BACKTICK),
        keywords: words("const let var function return if else for while do class extends new this typeof instanceof await async true false null undefined type interface implements public private protected readonly as number string boolean void"),
        builtins: words("console Math Object Array Number String"),
    },
    bash: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if then else elif fi for while do done case esac in echo local return"),
        builtins: words("echo printf"),
    },
    lua: {
        regex: tokenRegex(COMMENT_DASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if then else elseif end for while do function return local and or not true false nil in repeat until"),
        builtins: words("print type tostring tonumber"),
    },
    sqlite: {
        regex: tokenRegex(COMMENT_DASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("SELECT FROM WHERE AND OR NOT NULL AS INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INTEGER TEXT"),
        builtins: words("SUBSTR INSTR typeof LENGTH REPLACE TRIM"),
    },
    elixir: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("def defp if else do end case cond fn true false nil when"),
        builtins: words("IO Enum String"),
    },
    scala: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while do yield return val var def class object trait true false null new extends with match case"),
        builtins: words("println List Array"),
    },
    haskell: {
        regex: tokenRegex(COMMENT_DASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if then else let in where do case of module import data type True False"),
        builtins: words("print putStrLn sum product reverse head filter length foldl map"),
    },
    dart: {
        regex: tokenRegex(COMMENT_SLASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while do switch case default break continue return var final const class true false null new this void"),
        builtins: words("print"),
    },
    perl: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else elsif unless for while do my our sub return last next print say"),
        builtins: words("print length reverse uc"),
    },
    r: {
        regex: tokenRegex(COMMENT_HASH, STR_DOUBLE, STR_SINGLE),
        keywords: words("if else for while in function return TRUE FALSE NULL NA"),
        builtins: words("cat print sum c"),
    },
};

// Turns one line of code into text and colored <span>s
function highlight(line, language) {
    const syntax = SYNTAX[String(language).toLowerCase()];
    if (!syntax) return [line];

    const nodes = [];
    let last = 0;

    for (const m of line.matchAll(syntax.regex)) {
        if (m.index > last) nodes.push(line.slice(last, m.index));
        const end = m.index + m[0].length;

        let cls = null;
        if (m[1]) cls = "tok-comment";
        else if (m[2]) cls = "tok-string";
        else if (m[3]) cls = "tok-number";
        else if (syntax.keywords.has(m[4])) cls = "tok-keyword";
        else if (syntax.builtins.has(m[4])) cls = "tok-builtin";
        else if (/^!?\(/.test(line.slice(end))) cls = "tok-fn"; // name( or Rust macro name!(

        if (cls) {
            const span = document.createElement("span");
            span.className = cls;
            span.textContent = m[0];
            nodes.push(span);
        } else {
            nodes.push(m[0]);
        }
        last = end;
    }

    if (last < line.length) nodes.push(line.slice(last));
    return nodes;
}

function renderStatus() {
    $("daynum").textContent = ` · #${day + 1}`;

    const streak = visibleStreak();
    const badge = $("streak");
    if (streak > 0) {
        badge.hidden = false;
        badge.textContent = `🔥 ${streak}`;
        badge.title = `Streak: ${streak} day${streak === 1 ? "" : "s"}`;
    } else {
        badge.hidden = true;
        badge.textContent = "";
    }

    const progress = $("progress");
    progress.replaceChildren();
    progress.setAttribute("aria-hidden", puzzles.length ? "false" : "true");
    if (!puzzles.length) return;

    const done = today.results.length;
    progress.setAttribute("aria-label", `${Math.min(done, puzzles.length)} of ${puzzles.length} puzzles finished`);
    const finished = done >= puzzles.length;
    puzzles.forEach((_, i) => {
        const pip = document.createElement("span");
        pip.className = "pip";
        pip.setAttribute("role", "listitem");
        const result = today.results[i];
        let state = "upcoming";
        if (result) {
            pip.classList.add(result.correct ? "ok" : "fail");
            state = result.correct ? "solved" : "missed";
        } else if (!finished && i === done) {
            pip.classList.add("current");
            state = "current";
        }
        pip.setAttribute("aria-label", `Puzzle ${i + 1}, ${state}`);
        progress.append(pip);
    });
}

function showAnswer(className, text) {
    const el = $("result");
    el.className = className;
    el.textContent = text;
    if (!text) return;
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    el.scrollIntoView({ block: "nearest", behavior });
}

// View functions
function render() {
    renderStatus();
    $("window").classList.remove("glow");
    $("guess").classList.remove("shake");

    const index = today.results.length;
    if (index >= puzzles.length) return showFinish();

    const puzzle = puzzles[index];
    $("play").hidden = false;
    $("difficulty").textContent = puzzle.difficulty;
    $("difficulty").className = `badge d-${puzzle.difficulty.toLowerCase()}`;
    $("filename").textContent = `puzzle.${EXT[String(puzzle.language).toLowerCase()] ?? "txt"}`;
    $("info").innerHTML = `<span>Puzzle ${index + 1}/${puzzles.length}</span><span>Tries: ${today.tries}/${MAX_TRIES}</span>`;

    const codeEl = document.createElement("code");
    for (const line of puzzle.code.split("\n")) {
        const row = document.createElement("span");
        row.className = "line";
        row.append(...highlight(line, puzzle.language));
        codeEl.append(row);
    }
    $("code").replaceChildren(codeEl);

    $("wrongguesses").replaceChildren(
        ...today.wrong.map((w) => {
            const li = document.createElement("li");
            li.textContent = w;
            return li;
        })
    );

    showAnswer("", "");
    $("next").hidden = true;
    $("share").hidden = true;
    $("guess").disabled = false;
    $("guess").style.display = "";
    $("guess").focus();
    locked = false;
}

function showFinish() {
    locked = true;
    $("play").hidden = true;
    const score = today.results.filter((r) => r.correct).length;
    $("guess").disabled = true;
    $("code").replaceChildren();
    $("wrongguesses").replaceChildren();
    $("next").hidden = true;
    showAnswer("final", `Done for today! ${score}/${puzzles.length}\n\n${shareText()}`);
    $("share").hidden = false;
    $("share").textContent = "Share";
}

// Game
function finishPuzzle(correct, puzzle) {
    const attempts = correct ? today.tries + 1 : today.tries;
    today.results.push({ correct, attempts });
    today.tries = 0;
    today.wrong = [];

    const isLast = today.results.length === puzzles.length;
    if (isLast) updateStreak();
    writeSave();
    renderStatus();

    locked = true;
    $("guess").disabled = true;
    if (correct) {
        const win = $("window");
        win.classList.remove("glow");
        void win.offsetWidth;
        win.classList.add("glow");
    }
    showAnswer(
        correct ? "correct" : "wrong",
        correct
            ? `Correct! ${puzzle.explanation}`
            : `Out of tries! The answer was: ${puzzle.answer}. ${puzzle.explanation}`
    );
    $("next").textContent = isLast ? "See results" : "Next";
    $("next").hidden = false;
}

function shakeGuess() {
    const input = $("guess");
    input.classList.remove("shake");
    void input.offsetWidth;
    input.classList.add("shake");
}

function submitGuess() {
    if (locked) return;
    const index = today.results.length;
    if (index >= puzzles.length) return;

    const puzzle = puzzles[index];
    const input = $("guess").value;
    if (!input.trim()) return;
    $("guess").value = "";

    if (isCorrect(input, puzzle)) {
        finishPuzzle(true, puzzle);
        return;
    }

    today.tries++;
    today.wrong.push(input);
    if (today.tries >= MAX_TRIES) {
        finishPuzzle(false, puzzle);
    } else {
        writeSave();
        render();
        shakeGuess();
    }
}

function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) return Promise.reject(new Error("copy failed"));
    return Promise.resolve();
}

function flashShare(label) {
    const button = $("share");
    button.textContent = label;
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => {
        button.textContent = "Share";
    }, 2000);
}

// Events
$("guess").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitGuess();
});

$("next").addEventListener("click", render);

$("share").addEventListener("click", async () => {
    const text = shareText();
    try {
        if (navigator.share && navigator.maxTouchPoints > 0) {
            await navigator.share({ title: "Terminle", text });
            return;
        }
        await copyText(text);
        flashShare("Copied!");
    } catch (err) {
        if (err && err.name === "AbortError") return;
        try {
            await copyText(text);
            flashShare("Copied!");
        } catch {
            flashShare("Copy failed");
        }
    }
});

// Countdown timer
let countdownTimer = null;

function startCountdown() {
    const updateCountdown = () => {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 0, 0);
        const diff = midnight - now;

        if (diff <= 0) {
            clearInterval(countdownTimer);
            location.reload();
            return;
        }

        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);

        $("countdown").textContent = `Next puzzle in: ${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
}

// Start
async function init() {
    publishMeta();
    renderStatus();
    try {
        const all = await fetch("puzzles.json").then((r) => {
            if (!r.ok) throw new Error(`puzzles.json ${r.status}`);
            return r.json();
        });
        if (!Array.isArray(all) || all.length === 0) throw new Error("puzzles.json is empty");
        const set = all[day % all.length];
        if (!Array.isArray(set) || set.length === 0) throw new Error("today's set is empty");
        puzzles = set;
        render();
        startCountdown();
    } catch (err) {
        $("info").textContent = "Could not load today's puzzles.";
        $("guess").disabled = true;
        console.error(err);
    }
}

init();
