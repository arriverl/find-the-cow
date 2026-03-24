/** 每关在 4～13 之间随机一个 n，作为本关的 n×n 格子大小 */
function getRandomGridSize() {
    return 4 + Math.floor(Math.random() * 10); // 4..13
}

const INFINITE_INITIAL_TIME = 300;  // 无限模式初始 300 秒
const COINS_STORAGE_KEY = 'findTheCow_coins';
const INITIAL_COINS = 99;

let gridSize = 5;               // 当前 n×n 的 n
let currentLevel = 1;           // 当前关卡（过关模式）或显示用
let roundCount = 0;             // 无限模式本轮已过关数
let totalCowsCaught = 0;       // 无限模式累计抓到的牛数
let lastCowsMilestone = 0;     // 无限模式：上次弹情话的累计值（每 +50 弹一次）
let lives = 3;                  // 当前关剩余命数
let boardData = [];             // 存储单元格信息
let gameOver = false;           // 是否已游戏结束（命用尽或时间到）
let gameMode = null;            // 'normal' | 'infinite'
let timeLeft = INFINITE_INITIAL_TIME;  // 剩余秒数（仅无限模式）
let timerInterval = null;       // 倒计时 setInterval
const DOUBLE_CLICK_DELAY = 280;
const LONG_PRESS_MS = 400;
let clickPending = null;
let uiUpdateScheduled = false;
let longPressTimer = null;
let longPressDrawing = false;
let longPressTouchId = null;
let longPressMouse = false;

function updateResponsiveLayout() {
    const root = document.documentElement;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    document.body.classList.toggle('mobile-layout', isMobile);
    document.body.classList.toggle('desktop-layout', !isMobile);

    const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const sidePadding = isMobile ? 24 : 56;
    const boardPadding = 14;
    const gap = 2;
    const available = Math.max(180, viewportWidth - sidePadding - boardPadding * 2);
    const raw = Math.floor((available - gap * (gridSize - 1)) / Math.max(1, gridSize));

    const minSize = isMobile ? 24 : 28;
    const maxSize = isMobile ? 56 : 60;
    const cellSize = Math.max(minSize, Math.min(maxSize, raw));
    root.style.setProperty('--cell-size', `${cellSize}px`);
}

function getCoins() {
    const v = parseInt(localStorage.getItem(COINS_STORAGE_KEY), 10);
    return isNaN(v) || v < 0 ? INITIAL_COINS : v;
}
function setCoins(n) {
    localStorage.setItem(COINS_STORAGE_KEY, Math.max(0, n));
}
function updateCoinsDisplay() {
    const el = document.getElementById('coins');
    if (el) el.textContent = '金币: ' + getCoins();
}

function showHome() {
    document.getElementById('home').style.display = 'block';
    document.getElementById('game-screen').style.display = 'none';
    updateCoinsDisplay();
}

function showGameScreen() {
    document.getElementById('home').style.display = 'none';
    document.getElementById('game-screen').style.display = 'block';
}

/** 从首页选择模式后开始游戏 */
function startGame(mode) {
    gameMode = mode;
    gameOver = false;
    currentLevel = 1;
    roundCount = 0;
    totalCowsCaught = 0;
    lastCowsMilestone = 0;
    lives = 3;
    showGameScreen();
    startLevel(1);
}

/** 返回首页 */
function goHome() {
    stopTimer();
    gameMode = null;
    showHome();
}

/** 当前轮重新开始（保持模式） */
function restartRound() {
    if (!gameMode) return;
    gameOver = false;
    currentLevel = gameMode === 'normal' ? 1 : currentLevel;
    if (gameMode === 'infinite') {
        roundCount = 0;
        totalCowsCaught = 0;
        lastCowsMilestone = 0;
    }
    lives = 3;
    startLevel(gameMode === 'normal' ? 1 : 1);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function startTimer() {
    stopTimer();
    timeLeft = INFINITE_INITIAL_TIME;
    updateTimerDisplay();
    timerInterval = setInterval(tickTimer, 1000);
}

function tickTimer() {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) {
        stopTimer();
        handleTimeUp();
    }
}

function updateTimerDisplay() {
    const el = document.getElementById('timer');
    if (!el) return;
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    el.textContent = `剩余时间: ${m}:${s.toString().padStart(2, '0')}`;
    if (timeLeft <= 30) el.classList.add('timer-low');
    else el.classList.remove('timer-low');
}

function handleTimeUp() {
    const statusEl = document.getElementById('status');
    // 无限模式：询问是否用金币换 30 秒
    if (gameMode === 'infinite' && getCoins() >= 1 && confirm('是否用金币换30秒？')) {
        setCoins(getCoins() - 1);
        timeLeft = 30;
        startTimer();
        statusEl.classList.remove('lose');
        statusEl.textContent = '已用 1 金币换取 30 秒，继续游戏！';
        scheduleUIUpdate();
        return;
    }
    gameOver = true;
    statusEl.classList.add('lose');
    if (gameMode === 'normal') {
        statusEl.textContent = '时间到！本关未完成。可重新开始或返回首页。';
    } else {
        statusEl.textContent = `时间到！本轮通过 ${roundCount} 关，累计抓到 ${totalCowsCaught} 头牛。可再玩一局或返回首页。`;
    }
}

function initGame() {
    if (gameMode) restartRound();
    else startGame('normal');
}

/** 每批尝试次数：较小以便尽快让出主线程，避免卡在「生成地图中」 */
const GENERATE_BATCH_SIZE = 12;

/** 多解时反复修正，最多尝试 MAX_FIX 次 */
const MAX_FIX_ATTEMPTS = 8;

/** 尝试一批地图：先生成，若多解则用「划归格子」修正为唯一解，再校验是否等于种子（首轮） */
function tryGenerateOne(maxAttempts) {
    const n = gridSize;
    const limit = maxAttempts ?? GENERATE_BATCH_SIZE;
    for (let attempt = 0; attempt < limit; attempt++) {
        const seeds = generateCowSeeds();
        if (!seeds || seeds.length !== n) continue;
        const regions = generateRegions(seeds);
        let count = countSolutions(regions);

        if (count === 1) {
            if (uniqueSolutionEqualsSeeds(regions, seeds)) return { seeds, regions };
            continue;
        }
        if (count === 0) continue;

        // 多解：取前两个解，通过划归格子强行收敛为唯一解
        let solA = null, solB = null;
        const two = getFirstTwoSolutions(regions);
        if (two.length >= 2) {
            solA = two[0];
            solB = two[1];
        }
        for (let fixAttempt = 0; fixAttempt < MAX_FIX_ATTEMPTS && count >= 2 && solA && solB; fixAttempt++) {
            if (!fixMultiSolution(regions, solA, solB)) break;
            count = countSolutions(regions);
            if (count === 1) {
                const uniqueSol = getUniqueSolution(regions);
                if (uniqueSol && uniqueSol.length === n) {
                    return { seeds: uniqueSol, regions };
                }
            }
            if (count >= 2) {
                const nextTwo = getFirstTwoSolutions(regions);
                if (nextTwo.length >= 2) {
                    solA = nextTwo[0];
                    solB = nextTwo[1];
                }
            }
        }
    }
    return null;
}

/** 渲染已生成好的棋盘（仅在有 seeds、regions 时调用） */
function renderBoard(seeds, regions) {
    const boardEl = document.getElementById('game-board');
    const statusEl = document.getElementById('status');
    statusEl.classList.remove('win', 'lose');

    updateResponsiveLayout();
    boardEl.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
    boardEl.innerHTML = '';
    for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
            const cell = document.createElement('div');
            cell.className = `cell region-${regions[r][c] % 8}`;
            cell.dataset.r = r;
            cell.dataset.c = c;
            cell.addEventListener('click', handleCellClick);
            boardEl.appendChild(cell);

            boardData[r][c] = {
                region: regions[r][c],
                isCow: false,
                isMark: false,
                correctCow: seeds.some(s => s.r === r && s.c === c),
                el: cell
            };
        }
    }

    boardEl.removeEventListener('touchstart', handlePointerDown);
    boardEl.removeEventListener('mousedown', handlePointerDown);
    boardEl.addEventListener('touchstart', handlePointerDown, { passive: true });
    boardEl.addEventListener('mousedown', handlePointerDown);

    // 无限模式：下一轮接着上一轮剩余时间，不重置为 300；仅当时间已用完时才设为 300
    if (gameMode === 'infinite') {
        stopTimer();
        if (timeLeft <= 0) timeLeft = INFINITE_INITIAL_TIME;
        updateTimerDisplay();
        timerInterval = setInterval(tickTimer, 1000);
    } else {
        stopTimer();
    }
    updateUI();
}

/** 反复生成直到得到唯一解地图，再渲染；每批少量尝试后让出主线程，避免卡死 */
function startLevel(level) {
    currentLevel = level;
    gridSize = getRandomGridSize();
    lives = 3;
    gameOver = false;

    const boardEl = document.getElementById('game-board');
    const statusEl = document.getElementById('status');
    statusEl.classList.remove('win', 'lose');

    boardEl.style.gridTemplateColumns = '1fr';
    const msgEl = document.createElement('p');
    msgEl.className = 'generating-msg';
    msgEl.textContent = '生成地图中…';
    boardEl.innerHTML = '';
    boardEl.appendChild(msgEl);
    boardData = Array.from({ length: gridSize }, () => Array(gridSize).fill(null));

    let totalTries = 0;

    function tryBatch() {
        if (!gameMode) return;
        const result = tryGenerateOne(GENERATE_BATCH_SIZE);
        totalTries += GENERATE_BATCH_SIZE;
        if (result) {
            renderBoard(result.seeds, result.regions);
            return;
        }
        if (msgEl.parentNode) {
            msgEl.textContent = '生成地图中… (已尝试 ' + totalTries + ' 次)';
        }
        setTimeout(tryBatch, 20);
    }

    setTimeout(tryBatch, 20);
}

function generateCowSeeds() {
    const n = gridSize;
    const maxAttempts = 5000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const seeds = [];
        const colsUsed = new Set();

        for (let r = 0; r < n; r++) {
            const possibleCols = [];
            for (let c = 0; c < n; c++) {
                if (colsUsed.has(c)) continue;
                if (!isNearAnySeed(r, c, seeds)) possibleCols.push(c);
            }
            if (possibleCols.length === 0) break;

            const chosenCol = possibleCols[Math.floor(Math.random() * possibleCols.length)];
            seeds.push({ r, c: chosenCol });
            colsUsed.add(chosenCol);
        }

        if (seeds.length === n) return seeds;
    }
    return null;
}

function isNearAnySeed(r, c, seeds) {
    return seeds.some(s => Math.abs(s.r - r) <= 1 && Math.abs(s.c - c) <= 1);
}

/** 非对称生长：以一定概率推迟扩张，使边界参差不齐，减少对称矩形导致的多解 */
const BFS_SKIP_PROB = 0.14;

function generateRegions(seeds) {
    const n = gridSize;
    const grid = Array.from({ length: n }, () => Array(n).fill(-1));
    const queue = [];

    seeds.forEach((s, id) => {
        grid[s.r][s.c] = id;
        queue.push({ r: s.r, c: s.c, id });
    });

    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    while (queue.length > 0) {
        const idx = Math.floor(Math.random() * queue.length);
        const { r, c, id } = queue.splice(idx, 1)[0];

        const shuffled = [...dirs].sort(() => Math.random() - 0.5);
        for (const [dr, dc] of shuffled) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= n || nc < 0 || nc >= n || grid[nr][nc] !== -1) continue;
            if (Math.random() < BFS_SKIP_PROB) {
                queue.push({ r, c, id });
                continue;
            }
            grid[nr][nc] = id;
            queue.push({ r: nr, c: nc, id });
        }
    }
    return grid;
}

/** 合并到下一帧执行，减少快速连续点击时的卡顿 */
function scheduleUIUpdate() {
    if (uiUpdateScheduled) return;
    uiUpdateScheduled = true;
    requestAnimationFrame(() => {
        updateUI();
        checkWin();
        uiUpdateScheduled = false;
    });
}

/** 仅将格子设为 ×（用于长按拖拽），不取消牛、不切换空白 */
function setCellMarkOnly(r, c) {
    if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) return;
    const cell = boardData[r][c];
    const el = cell.el;
    if (cell.isCow) return; // 已是牛不改为×
    if (cell.isMark) return; // 已是×不重复操作
    cell.isMark = true;
    el.classList.add('mark');
    if (window.navigator.vibrate) window.navigator.vibrate(30);
}

/** 长按开始：触摸 */
function handlePointerDown(e) {
    if (gameOver) return;
    const isTouch = e.type === 'touchstart';
    const target = e.target;
    if (!target.classList || !target.classList.contains('cell')) return;
    const r = parseInt(target.dataset.r, 10);
    const c = parseInt(target.dataset.c, 10);

    const touchId = isTouch ? e.changedTouches[0].identifier : null;

    const startLongPressDraw = () => {
        longPressDrawing = true;
        if (clickPending && clickPending.r === r && clickPending.c === c) {
            clearTimeout(clickPending.timeoutId);
            clickPending = null;
        }
        setCellMarkOnly(r, c);
        scheduleUIUpdate();

        const onMove = (e2) => {
            if (!longPressDrawing) return;
            let x, y;
            if (e2.type.startsWith('touch')) {
                const t = Array.from(e2.touches).find(touch => touch.identifier === longPressTouchId)
                    || (e2.changedTouches && e2.changedTouches[0]);
                if (!t) return;
                x = t.clientX;
                y = t.clientY;
                e2.preventDefault();
            } else {
                x = e2.clientX;
                y = e2.clientY;
            }
            const el = document.elementFromPoint(x, y);
            if (el && el.dataset && el.dataset.r !== undefined) {
                const nr = parseInt(el.dataset.r, 10);
                const nc = parseInt(el.dataset.c, 10);
                setCellMarkOnly(nr, nc);
            }
        };

        const onEnd = (e2) => {
            longPressDrawing = false;
            longPressTouchId = null;
            longPressMouse = false;
            document.removeEventListener('touchmove', onMove, { capture: true });
            document.removeEventListener('touchend', onEnd, { capture: true });
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            if (e2.type.startsWith('touch')) e2.preventDefault(); // 阻止合成 click
            scheduleUIUpdate();
        };

        if (isTouch) {
            longPressTouchId = touchId;
            document.addEventListener('touchmove', onMove, { passive: false, capture: true });
            document.addEventListener('touchend', onEnd, { capture: true });
        } else {
            longPressMouse = true;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        }
    };

    if (isTouch) {
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            startLongPressDraw();
        }, LONG_PRESS_MS);
    } else {
        if (e.button !== 0) return;
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            startLongPressDraw();
        }, LONG_PRESS_MS);
    }
}

/** 触摸结束 / 鼠标松开时若未进入长按则清除定时器，并允许正常 click */
function handlePointerUp(e) {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

// 在 document 上监听，确保手指/鼠标在别处松开也能清除定时器
document.addEventListener('touchend', handlePointerUp, { capture: true });
document.addEventListener('touchcancel', handlePointerUp, { capture: true });
document.addEventListener('mouseup', handlePointerUp);

/** 收集区域格子：regionCells[id] = 该区域所有 (r,c)，id 严格 0..n-1 */
function buildRegionCells(regions) {
    const n = regions.length;
    const regionCells = Array.from({ length: n }, () => []);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const id = regions[r][c];
            if (typeof id === 'number' && id >= 0 && id < n) {
                regionCells[id].push({ r, c });
            }
        }
    }
    return regionCells;
}

/** 位运算 + MRV：统计解数量，≥2 即停；可选返回前两个解 [solA, solB] */
function solveWithBitmask(regions, collectTwo) {
    const n = regions.length;
    const regionCells = buildRegionCells(regions);
    for (let i = 0; i < n; i++) {
        if (regionCells[i].length === 0) return { count: 0, solutions: [] };
    }

    // MRV：按区域格子数升序，优先填可选最少的区域
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => regionCells[a].length - regionCells[b].length);
    const orderedCells = order.map(i => regionCells[i]);

    let count = 0;
    const solutions = [];

    function backtrack(slotIdx, rowMask, colMask, lastCows) {
        if (count >= 2) return;
        if (slotIdx === n) {
            count++;
            if (collectTwo && solutions.length < 2) {
                solutions.push(lastCows.map(c => ({ r: c.r, c: c.c })));
            }
            return;
        }

        for (const cell of orderedCells[slotIdx]) {
            const rBit = 1 << cell.r;
            const cBit = 1 << cell.c;
            if ((rowMask & rBit) || (colMask & cBit)) continue;

            let nearConflict = false;
            for (let i = 0; i < lastCows.length; i++) {
                const cow = lastCows[i];
                if (Math.abs(cow.r - cell.r) <= 1 && Math.abs(cow.c - cell.c) <= 1) {
                    nearConflict = true;
                    break;
                }
            }
            if (nearConflict) continue;

            lastCows.push(cell);
            backtrack(slotIdx + 1, rowMask | rBit, colMask | cBit, lastCows);
            lastCows.pop();
        }
    }

    backtrack(0, 0, 0, []);
    return { count, solutions };
}

function countSolutions(regions) {
    return solveWithBitmask(regions, false).count;
}

/** 返回前两个解（若存在），用于多解修正 */
function getFirstTwoSolutions(regions) {
    return solveWithBitmask(regions, true).solutions;
}

/** 当解唯一时返回唯一解（n 个 {r,c}），否则 null */
function getUniqueSolution(regions) {
    const { count, solutions } = solveWithBitmask(regions, true);
    return count === 1 && solutions.length === 1 ? solutions[0] : null;
}

function solutionSetKey(cell) {
    return cell.r * 100 + cell.c;
}

/** 判断唯一解是否就是种子（同一组格子） */
function uniqueSolutionEqualsSeeds(regions, seeds) {
    const sol = getUniqueSolution(regions);
    if (!sol || sol.length !== seeds.length) return false;
    const set = new Set(seeds.map(s => s.r * 100 + s.c));
    for (const c of sol) {
        if (!set.has(solutionSetKey(c))) return false;
    }
    return true;
}

/** 多解修正：取解 B 中多出的格子，划归到相邻区域，使解 B 不再合法 */
function fixMultiSolution(regions, solA, solB) {
    const setA = new Set(solA.map(solutionSetKey));
    const n = regions.length;
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    for (const cell of solB) {
        if (setA.has(solutionSetKey(cell))) continue;
        const r = cell.r, c = cell.c;
        const R = regions[r][c];

        for (const [dr, dc] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= n || nc < 0 || nc >= n) continue;
            const S = regions[nr][nc];
            if (S === R) continue;
            regions[r][c] = S;
            return true;
        }
    }
    return false;
}

/** 单击：空白↔×；连续双击：标为牛（标错扣命） */
function handleCellClick(e) {
    if (gameOver) return;

    if (window.navigator.vibrate) {
        window.navigator.vibrate(50); // 轻轻震动 50ms，手机手感反馈
    }

    const r = parseInt(e.currentTarget.dataset.r, 10);
    const c = parseInt(e.currentTarget.dataset.c, 10);
    const cell = boardData[r][c];
    const el = e.currentTarget;

    // 同一格在延迟内再次点击 → 视为双击 → 标牛
    if (clickPending && clickPending.r === r && clickPending.c === c) {
        clearTimeout(clickPending.timeoutId);
        clickPending = null;
        applyMarkAsCow(cell, el);
        return;
    }

    if (clickPending) {
        clearTimeout(clickPending.timeoutId);
        clickPending = null;
    }

    clickPending = {
        r, c,
        timeoutId: setTimeout(() => {
            clickPending = null;
            // 单击：空白 → ×，× → 空白；若已是牛则单击取消为空白
            if (cell.isCow) {
                cell.isCow = false;
                el.classList.remove('cow');
            } else if (cell.isMark) {
                cell.isMark = false;
                el.classList.remove('mark');
            } else {
                cell.isMark = true;
                el.classList.add('mark');
            }
            document.querySelectorAll('.cell.error').forEach(n => n.classList.remove('error'));
            scheduleUIUpdate();
        }, DOUBLE_CLICK_DELAY)
    };
}

/** 将格子标为牛；若位置错误则扣命并恢复为 × */
function applyMarkAsCow(cell, el) {
    if (cell.isCow) {
        cell.isCow = false;
        el.classList.remove('cow');
        scheduleUIUpdate();
        return;
    }

    cell.isMark = false;
    cell.isCow = true;
    el.classList.remove('mark');
    el.classList.add('cow');

    if (!cell.correctCow) {
        // 无限模式：无命数限制，只扣 10 秒
        if (gameMode === 'infinite') {
            timeLeft = Math.max(0, timeLeft - 10);
            updateTimerDisplay();
            el.classList.add('error');
            setTimeout(() => {
                cell.isCow = false;
                cell.isMark = true;
                el.classList.remove('cow', 'error');
                el.classList.add('mark');
                scheduleUIUpdate();
            }, 400);
            scheduleUIUpdate();
            if (timeLeft <= 0) {
                stopTimer();
                handleTimeUp();
            }
            return;
        }
        // 过关模式：扣命，命尽可金币买命
        lives--;
        el.classList.add('error');
        setTimeout(() => {
            cell.isCow = false;
            cell.isMark = true;
            el.classList.remove('cow', 'error');
            el.classList.add('mark');
            scheduleUIUpdate();
        }, 400);
        scheduleUIUpdate();
        if (lives <= 0) {
            const statusEl = document.getElementById('status');
            if (getCoins() >= 1 && confirm('是否用一个金币买一条命？')) {
                setCoins(getCoins() - 1);
                lives = 1;
                statusEl.classList.remove('lose');
                statusEl.textContent = '已用 1 金币购买一条命，继续游戏！';
                scheduleUIUpdate();
                return;
            }
            gameOver = true;
            statusEl.textContent = '游戏结束！命已用尽。' + (getCoins() < 1 ? '（金币不足）' : '') + '点击「重新开始」或返回首页。';
            statusEl.classList.add('lose');
        }
        return;
    }

    // 无限模式：找对一头牛加 5 秒
    if (gameMode === 'infinite') {
        timeLeft += 5;
        updateTimerDisplay();
    }
    document.querySelectorAll('.cell.error').forEach(n => n.classList.remove('error'));
    scheduleUIUpdate();
}

function updateUI() {
    const statusEl = document.getElementById('status');
    const levelEl = document.getElementById('level');
    const livesEl = document.getElementById('lives');

    if (levelEl) {
        if (gameMode === 'infinite') {
            levelEl.textContent = `第 ${roundCount + 1} 轮 · ${gridSize}×${gridSize} · 累计 ${totalCowsCaught} 头牛`;
        } else {
            levelEl.textContent = `第 ${currentLevel} 关 · ${gridSize}×${gridSize}`;
        }
    }
    // 过关模式显示命数，无限模式无命数限制不显示
    if (livesEl) {
        if (gameMode === 'infinite') {
            livesEl.style.display = 'none';
        } else {
            livesEl.style.display = '';
            livesEl.textContent = '❤️'.repeat(lives) + '♡'.repeat(3 - lives);
        }
    }

    // 过关模式不显示计时，无限模式显示剩余时间
    const timerEl = document.getElementById('timer');
    if (timerEl) {
        if (gameMode === 'infinite') {
            timerEl.style.display = '';
            timerEl.textContent = `剩余时间: ${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, '0')}`;
            if (timeLeft <= 30) timerEl.classList.add('timer-low');
            else timerEl.classList.remove('timer-low');
        } else {
            timerEl.style.display = 'none';
        }
    }

    if (gameOver) return;

    const correctCows = countCorrectCows();
    const remaining = gridSize - correctCows;
    if (remaining > 0 && statusEl && !statusEl.classList.contains('win')) {
        statusEl.textContent = `剩余小牛: ${remaining} · 单击×/取消×，双击标牛`;
    }
}

function countCorrectCows() {
    let n = 0;
    for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
            if (boardData[r][c].isCow && boardData[r][c].correctCow) n++;
        }
    }
    return n;
}

/** 无限模式每累计 +50 头牛弹出一条表扬女朋友的情话 */
const ROMANTIC_COMPLIMENTS = [
    '你是我的小幸运，抓到多少头牛都不如你重要～',
    '宝贝最聪明，找牛都这么厉害，爱你！',
    '和你在一起的每一刻都像过关一样开心～',
    '你玩游戏的样子也太可爱了吧！',
    '我家宝贝就是厉害，继续冲！',
    '你是我的唯一解，就像这道题只有你一个答案。',
    '抓到再多的牛，也抓不住我对你的喜欢～',
    '你认真找牛的样子，让我更喜欢你了。',
    '宝贝真棒！奖励一个抱抱～',
    '有你在，连找牛都变得甜了。',
    '你是我心里唯一的小牛，别的牛都是过客～',
    '再多的关也难不倒你，因为你最厉害！',
    '每次你过关，我都想给你点一万个赞。',
    '和你一起的时光，比通关还有成就感。',
    '宝贝，你找牛的样子帅到我了！',
];

function showRomanticCompliment() {
    const text = ROMANTIC_COMPLIMENTS[Math.floor(Math.random() * ROMANTIC_COMPLIMENTS.length)];
    alert('💕 ' + text);
}

function checkWin() {
    if (gameOver) return;

    const correctCows = countCorrectCows();
    if (correctCows !== gridSize) return;

    stopTimer();
    const statusEl = document.getElementById('status');
    if (gameMode === 'infinite') {
        totalCowsCaught += gridSize;
        roundCount++;
        while (totalCowsCaught >= lastCowsMilestone + 50) {
            lastCowsMilestone += 50;
            showRomanticCompliment();
        }
        statusEl.textContent = `🎉 通过！本轮已过 ${roundCount} 关，累计 ${totalCowsCaught} 头牛，即将下一轮…`;
    } else {
        statusEl.textContent = `🎉 第 ${currentLevel} 关通过！即将进入下一关…`;
    }
    statusEl.classList.add('win');

    setTimeout(() => {
        if (gameMode === 'infinite') {
            startLevel(1); // 新的一轮，随机 n
        } else {
            startLevel(currentLevel + 1);
        }
    }, 1200);
}

// 页面加载：显示首页，绑定模式按钮
function init() {
    updateResponsiveLayout();
    if (localStorage.getItem(COINS_STORAGE_KEY) === null) {
        localStorage.setItem(COINS_STORAGE_KEY, String(INITIAL_COINS));
    }
    updateCoinsDisplay();
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-mode');
            if (mode === 'normal' || mode === 'infinite') startGame(mode);
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

window.addEventListener('resize', updateResponsiveLayout);
window.addEventListener('orientationchange', updateResponsiveLayout);
