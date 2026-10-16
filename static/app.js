/* ═══════════════════════════════════════════════════════════════════════════
   Server Monitor Dashboard — App Logic
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
    "use strict";

    // ─── Config ──────────────────────────────────────────────────────────────
    let STATS_INTERVAL = parseInt(localStorage.getItem('uiRefreshInterval')) * 1000 || 3000;
    const CHART_INTERVAL = 60_000;  // charts every 60 seconds
    const CIRCUMFERENCE = 2 * Math.PI * 52; // gauge circle circumference

    // ─── Legend Hover-Bold Helper ─────────────────────────────────────────────
    // Tracks which dataset index is hovered per chart (WeakMap, GC-friendly).
    const _legendHover = new WeakMap();

    /**
     * Returns a Chart.js legend config object identical to `base` but with
     * onHover / onLeave callbacks that bold the hovered item's label text.
     * Merges cleanly with any labels sub-config you pass in.
     */
    function makeLegend(base) {
        const bl = (base.labels || {});
        return {
            ...base,
            onHover(e, item, legend) {
                if (legend.chart.canvas) {
                    legend.chart.canvas.style.cursor = item ? 'pointer' : 'default';
                }
                const idx = (item && typeof item.datasetIndex !== 'undefined') ? item.datasetIndex : -1;
                if (_legendHover.get(legend.chart) !== idx) {
                    if (idx >= 0) {
                        _legendHover.set(legend.chart, idx);
                    } else {
                        _legendHover.delete(legend.chart);
                    }
                    legend.chart.update('none');
                }
            },
            onLeave(e, item, legend) {
                if (legend.chart.canvas) {
                    legend.chart.canvas.style.cursor = 'default';
                }
                if (_legendHover.has(legend.chart)) {
                    _legendHover.delete(legend.chart);
                    legend.chart.update('none');
                }
            },
            labels: {
                ...bl,
                generateLabels(chart) {
                    const hIdx = _legendHover.has(chart) ? _legendHover.get(chart) : -1;
                    const orig = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                    return orig.map(lbl => {
                        const isHovered = (hIdx >= 0 && lbl.datasetIndex === hIdx);
                        lbl.font = {
                            size: bl.font?.size || 11,
                            family: bl.font?.family || "'Inter', sans-serif",
                            weight: isHovered ? 'bold' : 'normal'
                        };
                        return lbl;
                    });
                }
            }
        };
    }

    // ─── Tooltip Helpers ─────────────────────────────────────────────────────
    function formatTooltipLabel(ctx, text) {
        const isHovered = (_legendHover.has(ctx.chart) && _legendHover.get(ctx.chart) === ctx.datasetIndex);
        return isHovered ? `➔ ${text}` : `  ${text}`;
    }

    function getTooltipLabelColor(ctx) {
        const dark = isDarkMode();
        const hasHover = _legendHover.has(ctx.chart);
        if (!hasHover) {
            return dark ? "#94a3b8" : "#475569";
        }
        const isHovered = (_legendHover.get(ctx.chart) === ctx.datasetIndex);
        if (dark) {
            return isHovered ? "#ffffff" : "rgba(255, 255, 255, 0.4)";
        } else {
            return isHovered ? "#0f172a" : "#94a3b8";
        }
    }

    function getTooltipConfig(labelCallback) {
        return {
            backgroundColor: () => isDarkMode() ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.98)",
            titleColor: () => isDarkMode() ? "#f8fafc" : "#1e293b",
            bodyColor: () => isDarkMode() ? "#94a3b8" : "#475569",
            borderColor: () => isDarkMode() ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
            titleFont: { family: "'Inter', sans-serif", weight: "600", size: 12 },
            bodyFont: { family: "'Inter', sans-serif", size: 11 },
            callbacks: {
                title: (items) => {
                    if (items.length > 0) {
                        const d = new Date(items[0].parsed.x);
                        return d.toLocaleString();
                    }
                    return "";
                },
                label: labelCallback,
                labelTextColor: (ctx) => getTooltipLabelColor(ctx)
            }
        };
    }

    const RANGE_MS = {
        "1h": 3600 * 1000,
        "2h": 7200 * 1000,
        "6h": 21600 * 1000,
        "12h": 43200 * 1000,
        "1d": 86400 * 1000,
        "2d": 172800 * 1000,
        "1w": 604800 * 1000,
        "1m": 2592000 * 1000
    };

    let currentRange = "1h";
    let customSeconds = null; // null = use preset range, number = custom seconds
    let statsTimer = null;
    let chartTimer = null;
    let selectedNic = null;  // will be set from /api/interfaces

    // ─── Smoothing (Moving Average) ─────────────────────────────────────────
    function getSmoothWindow() {
        const el = document.getElementById("smoothLevel");
        return el ? (parseInt(el.value, 10) || 0) : 0;
    }

    /**
     * Apply a simple centered moving average to an array of {x, y} points.
     * Returns a new array with smoothed y values; x values are preserved.
     * window=0 means no smoothing (returns original data).
     */
    function movingAverage(data, window) {
        if (!window || window < 2 || data.length < window) return data;
        const half = Math.floor(window / 2);
        return data.map((point, i) => {
            if (point.y === null || point.y === undefined) return point;
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(data.length - 1, i + half); j++) {
                if (data[j].y !== null && data[j].y !== undefined) {
                    sum += parseFloat(data[j].y);
                    count++;
                }
            }
            return { x: point.x, y: count > 0 ? sum / count : point.y };
        });
    }

    // Returns the user-defined max Mbps from the input (default 400)
    function getNetMax() {
        const el = document.getElementById("netMaxMbps");
        return el ? (parseFloat(el.value) || 400) : 400;
    }

    // Returns appropriate grid line color based on current theme
    function getGridColor() {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        const lightThemes = ["light", "catppuccin-latte", "solarized-light"];
        if (lightThemes.includes(theme)) return "rgba(0,0,0,0.08)";
        if (theme === "dark") return "rgba(255,255,255,0.06)";
        if (theme === "cyberpunk") return "rgba(0, 243, 255, 0.20)";
        if (theme === "oled") return "rgba(255,255,255,0.22)";
        return "rgba(255,255,255,0.10)";
    }

    // Apply grid color to all active charts
    function updateAllChartsGridColor() {
        const color = getGridColor();
        const charts = [cpuChart, ramChart, diskChart, diskIopsChart, netChart, connChart, loadChart];
        charts.forEach(ch => {
            if (!ch) return;
            const scales = ch.options.scales;
            if (!scales) return;
            Object.values(scales).forEach(scale => {
                if (scale.grid) scale.grid.color = color;
            });
            ch.update("none");
        });
    }

    // ─── Color Definitions ───────────────────────────────────────────────────
    const COLORS = {
        cpu: { start: "#22c55e", end: "#10b981", bg: "rgba(34,197,94,0.08)" },
        ram: { start: "#38bdf8", end: "#6366f1", bg: "rgba(56,189,248,0.08)" },
        disk: { start: "#fb923c", end: "#f59e0b", bg: "rgba(251,146,60,0.08)" },
        netSent: { start: "#22c55e", end: "#10b981", bg: "rgba(34,197,94,0.08)" },
        netRecv: { start: "#38bdf8", end: "#60a5fa", bg: "rgba(56,189,248,0.08)" },
        tcp: { start: "#f59e0b", end: "#d97706", bg: "rgba(245,158,11,0.08)" },
        udp: { start: "#ef4444", end: "#dc2626", bg: "rgba(239,68,68,0.08)" },
        load: { start: "#f43f5e", end: "#fb7185", bg: "rgba(244,63,94,0.08)" }
    };

    // ─── SVG Gradient Definitions ────────────────────────────────────────────
    function injectSVGGradients() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.style.position = "absolute";
        svg.innerHTML = `
            <defs>
                <linearGradient id="cpuGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" style="stop-color: var(--cpu-start, #22c55e);"/>
                    <stop offset="100%" style="stop-color: var(--cpu-end, #10b981);"/>
                </linearGradient>
                <linearGradient id="ramGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" style="stop-color: var(--ram-start, #38bdf8);"/>
                    <stop offset="100%" style="stop-color: var(--ram-end, #6366f1);"/>
                </linearGradient>
                <linearGradient id="diskGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" style="stop-color: var(--disk-start, #fb923c);"/>
                    <stop offset="100%" style="stop-color: var(--disk-end, #f59e0b);"/>
                </linearGradient>
            </defs>
        `;
        document.body.prepend(svg);
    }

    // ─── Chart Setup ─────────────────────────────────────────────────────────

    const chartOptions = (yLabel, format = "percent", forceLegend = false) => {
        const isPercent = format === "percent" || format === true;
        const isNetwork = format === "network" || format === false;
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: "index",
                intersect: false
            },
            onHover(event, activeElements, chart) {
                const nativeEvt = event.native || event;
                const nearest = chart.getElementsAtEventForMode(nativeEvt, 'nearest', { intersect: false }, true);
                const idx = (nearest && nearest[0]) ? nearest[0].datasetIndex : -1;
                
                chart.data.datasets.forEach((dataset, i) => {
                    if (typeof dataset._origBorderWidth === 'undefined') {
                        dataset._origBorderWidth = dataset.borderWidth || 1.2;
                    }
                    const isHovered = (idx >= 0 && i === idx);
                    dataset.borderWidth = isHovered ? (dataset._origBorderWidth + 1) : dataset._origBorderWidth;
                });
                
                if (_legendHover.get(chart) !== idx) {
                    if (idx >= 0) {
                        _legendHover.set(chart, idx);
                    } else {
                        _legendHover.delete(chart);
                    }
                }
                
                if (!chart.canvas._hasMouseOutListener) {
                    chart.canvas._hasMouseOutListener = true;
                    chart.canvas.addEventListener('mouseout', () => {
                        chart.data.datasets.forEach((ds) => {
                            if (typeof ds._origBorderWidth !== 'undefined') {
                                ds.borderWidth = ds._origBorderWidth;
                            }
                        });
                        _legendHover.delete(chart);
                        chart.update('none');
                    });
                }
                
                chart.update('none');
            },
            plugins: {
                legend: makeLegend({
                    display: forceLegend || isPercent,
                    position: "top",
                    labels: {
                        color: "#475569",
                        font: { family: "'Inter', sans-serif", size: 11 },
                        boxWidth: 12,
                        padding: 12
                    }
                }),
                tooltip: getTooltipConfig((ctx) => {
                    const val = ctx.parsed.y;
                    if (val === null) return null;
                    let labelText;
                    if (isPercent) {
                        labelText = `${ctx.dataset.label}: ${val.toFixed(1)}%`;
                    } else if (isNetwork) {
                        labelText = `${ctx.dataset.label}: ${val.toFixed(2)} Mbps`;
                    } else {
                        labelText = `${ctx.dataset.label}: ${val.toFixed(2)}`;
                    }
                    return formatTooltipLabel(ctx, labelText);
                })
            },
            scales: {
                x: {
                    type: "time",
                    time: {
                        tooltipFormat: "PPpp"
                    },
                    grid: {
                        color: getGridColor(),
                        drawBorder: false
                    },
                    ticks: {
                        color: "#64748b",
                        font: { family: "'Inter', sans-serif", size: 10 },
                        maxRotation: 0,
                        autoSkipPadding: 20,
                        maxTicksLimit: 8
                    }
                },
                y: {
                    beginAtZero: true,
                    max: isPercent ? 100 : undefined,
                    grid: {
                        color: getGridColor(),
                        drawBorder: false
                    },
                    ticks: {
                        color: "#64748b",
                        font: { family: "'Inter', sans-serif", size: 10 },
                        callback: (val) => {
                            if (isPercent) return val + "%";
                            if (isNetwork) return val.toFixed(1) + " Mbps";
                            return val.toFixed(2);
                        },
                        maxTicksLimit: 6
                    }
                }
            },
            elements: {
                point: { radius: 0, hoverRadius: 4, hitRadius: 20 },
                line: { tension: 0.4, borderWidth: 1.2 }
            },
            animation: {
                duration: 800,
                easing: "easeInOutQuart"
            }
        };
    };

    function createGradient(ctx, startColor, endColor, bgAlpha = 0.15) {
        const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
        gradient.addColorStop(0, startColor + hexAlpha(bgAlpha));
        gradient.addColorStop(1, startColor + "00");
        return gradient;
    }

    function hexAlpha(a) {
        return Math.round(a * 255).toString(16).padStart(2, "0");
    }

    // ─── Peak / Max Point Callout Plugin ──────────────────────────────────────
    const maxPointLabelPlugin = {
        id: "maxPointLabel",
        afterDatasetsDraw(chart) {
            try {
                if (!chart || !chart.data || !chart.data.datasets || chart.data.datasets.length === 0) return;
                const canvasId = chart.canvas ? chart.canvas.id : "";
                if (canvasId === "payloadDailyChart") return;
                const ctx = chart.ctx;
                if (!ctx) return;

                // Target specific dataset indexes per chart based on user preferences
                let targetDatasets = [];

                if (canvasId === "cpuChart") {
                    // CPU: ONLY target dataset 0 (CPU Avg)
                    targetDatasets = [0];
                } else if (canvasId === "loadChart") {
                    // Load Average: ONLY target dataset 2 (15 Min load) if visible, else dataset 0
                    if (chart.isDatasetVisible && chart.isDatasetVisible(2)) {
                        targetDatasets = [2];
                    } else if (chart.isDatasetVisible && chart.isDatasetVisible(0)) {
                        targetDatasets = [0];
                    } else {
                        targetDatasets = [2, 0];
                    }
                } else if (canvasId === "ramChart") {
                    // Memory Usage: ONLY target dataset 0 (Used %)
                    targetDatasets = [0];
                } else if (canvasId === "diskChart") {
                    // Disk Usage: ONLY target dataset 0 (Disk %)
                    targetDatasets = [0];
                } else {
                    // All other charts (netChart, connChart, diskIopsChart): check all visible datasets
                    targetDatasets = chart.data.datasets.map((_, idx) => idx);
                }

                let globalMaxVal = -Infinity;
                let globalMaxDatasetIdx = -1;
                let globalMaxPointIdx = -1;

                targetDatasets.forEach(dIdx => {
                    if (dIdx < 0 || dIdx >= chart.data.datasets.length) return;
                    if (chart.isDatasetVisible && !chart.isDatasetVisible(dIdx)) return;
                    const meta = chart.getDatasetMeta(dIdx);
                    if (!meta || meta.hidden) return;
                    const dataset = chart.data.datasets[dIdx];
                    if (!dataset || !dataset.data || dataset.data.length === 0) return;

                    for (let i = 0; i < dataset.data.length; i++) {
                        const pt = dataset.data[i];
                        if (!pt) continue;
                        const val = (typeof pt === 'object' && pt !== null && 'y' in pt) ? pt.y : pt;
                        if (val !== null && val !== undefined && !isNaN(val) && val > globalMaxVal) {
                            globalMaxVal = val;
                            globalMaxDatasetIdx = dIdx;
                            globalMaxPointIdx = i;
                        }
                    }
                });

                if (globalMaxDatasetIdx < 0 || globalMaxPointIdx < 0 || globalMaxVal <= 0) return;

                const targetDataset = chart.data.datasets[globalMaxDatasetIdx];
                const meta = chart.getDatasetMeta(globalMaxDatasetIdx);
                if (!meta || !meta.data || !meta.data[globalMaxPointIdx]) return;

                const elem = meta.data[globalMaxPointIdx];
                const x = elem.x;
                const y = elem.y;
                if (isNaN(x) || isNaN(y)) return;

                const rawPt = targetDataset.data[globalMaxPointIdx];
                const rawVal = (typeof rawPt === 'object' && rawPt !== null && 'y' in rawPt) ? rawPt.y : rawPt;
                if (rawVal === null || rawVal === undefined || isNaN(rawVal) || rawVal <= 0) return;

                ctx.save();

                const dsColor = targetDataset.borderColor || "#ef4444";

                // Draw small dot on peak point
                ctx.beginPath();
                ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
                ctx.fillStyle = dsColor;
                ctx.fill();
                ctx.lineWidth = 1.2;
                ctx.strokeStyle = "#ffffff";
                ctx.stroke();

                // Custom Label formatting per chart / dataset
                const label = targetDataset.label || "";
                let valStr = (rawVal >= 100) ? Math.round(rawVal).toString() : rawVal.toFixed(1);

                let labelText = `▲ Max: ${valStr}`;
                if (canvasId === "cpuChart") {
                    labelText = `▲ CPU Max: ${valStr}%`;
                } else if (canvasId === "loadChart") {
                    labelText = `▲ 15m Load Max: ${rawVal.toFixed(2)}`;
                } else if (canvasId === "ramChart") {
                    labelText = `▲ Used RAM Max: ${valStr}%`;
                } else if (canvasId === "diskChart") {
                    labelText = `▲ Disk Max: ${valStr}%`;
                } else if (label === "Upload") {
                    labelText = `↑ Up Max: ${valStr} Mbps`;
                } else if (label === "Download") {
                    labelText = `↓ Down Max: ${valStr} Mbps`;
                } else if (label === "TCP" || label === "UDP") {
                    labelText = `▲ ${label} Max: ${valStr}`;
                } else if (label === "Read IOPS" || label === "Write IOPS") {
                    labelText = `▲ ${label} Max: ${valStr}`;
                } else if (label) {
                    labelText = `▲ ${label} Max: ${valStr}`;
                }

                ctx.font = "600 9px 'Inter', sans-serif";
                const textWidth = ctx.measureText(labelText).width;
                const badgeW = textWidth + 8;
                const badgeH = 14;
                const badgeX = Math.max(4, Math.min(chart.width - badgeW - 4, x - badgeW / 2));
                const badgeY = Math.max(4, y - 18);

                // Background pill
                ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3.5);
                } else {
                    ctx.rect(badgeX, badgeY, badgeW, badgeH);
                }
                ctx.fill();
                ctx.strokeStyle = dsColor;
                ctx.lineWidth = 1;
                ctx.stroke();

                // Text
                ctx.fillStyle = "#ffffff";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(labelText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);

                ctx.restore();
            } catch (err) {
                // Ignore errors inside plugin to ensure charts never fail to draw
            }
        }
    };

    Chart.register(maxPointLabelPlugin);

    let cpuChart, ramChart, diskChart, diskIopsChart, payloadDailyChart, netChart, connChart, loadChart;
    let lastConnData = [];  // store last fetched data for re-filtering

    function initCharts() {
        const cpuCtx = document.getElementById("cpuChart").getContext("2d");
        cpuChart = new Chart(cpuCtx, {
            type: "line",
            data: {
                datasets: [{
                    label: "CPU Avg",
                    data: [],
                    borderColor: COLORS.cpu.start,
                    backgroundColor: createGradient(cpuCtx, COLORS.cpu.start, COLORS.cpu.end),
                    fill: true,
                    borderWidth: 1.2
                }]
            },
            options: chartOptions("CPU %", true, true)
        });

        // Apply saved max CPU from localStorage
        const savedCpuMax = localStorage.getItem("cpuMaxPercent");
        if (savedCpuMax) {
            const el = document.getElementById("cpuDynamicMax");
            if (el) el.value = savedCpuMax;
            cpuChart.options.scales.y.max = parseInt(savedCpuMax, 10);
        }

        // Listen for CPU max input changes (fires instantly on typing)
        const cpuMaxInput = document.getElementById("cpuDynamicMax");
        const cpuAutoEl = document.getElementById("cpuChartAutoMax");
        if (cpuMaxInput) {
            cpuMaxInput.addEventListener("input", (e) => {
                let max = parseInt(e.target.value, 10);
                if (cpuAutoEl && cpuAutoEl.checked) {
                    cpuAutoEl.checked = false;
                }
                if (isNaN(max) || max <= 0) {
                    localStorage.removeItem("cpuMaxPercent");
                    cpuChart.options.scales.y.max = 100;
                } else {
                    if (max > 100) max = 100;
                    localStorage.setItem("cpuMaxPercent", max);
                    cpuChart.options.scales.y.max = max;
                }
                cpuChart.update("none");
            });
        }

        if (cpuAutoEl) {
            cpuAutoEl.addEventListener("change", (e) => {
                if (e.target.checked) {
                    cpuChart.options.scales.y.max = null;
                } else {
                    const manual = parseInt(cpuMaxInput ? cpuMaxInput.value : 70, 10) || 70;
                    cpuChart.options.scales.y.max = manual;
                }
                cpuChart.update("none");
            });
        }


        const loadCtx = document.getElementById("loadChart").getContext("2d");
        loadChart = new Chart(loadCtx, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "1 Min",
                        data: [],
                        borderColor: "#f43f5e",
                        backgroundColor: "transparent",
                        fill: false,
                        borderWidth: 1.2,
                        pointRadius: 0
                    },
                    {
                        label: "5 Min",
                        data: [],
                        borderColor: "#3b82f6",
                        backgroundColor: "transparent",
                        fill: false,
                        borderWidth: 1.2,
                        pointRadius: 0
                    },
                    {
                        label: "15 Min",
                        data: [],
                        borderColor: "#10b981",
                        backgroundColor: "transparent",
                        fill: false,
                        borderWidth: 1,
                        pointRadius: 0
                    }
                ]
            },
            options: chartOptions("Load Average", "raw", true)
        });


        const ramCtx = document.getElementById("ramChart").getContext("2d");
        ramChart = new Chart(ramCtx, {
            type: "line",
            data: {
                datasets: [{
                    label: "Used %",
                    data: [],
                    borderColor: COLORS.ram.start,
                    backgroundColor: createGradient(ramCtx, COLORS.ram.start, COLORS.ram.end),
                    fill: true
                }]
            },
            options: chartOptions("Memory %", true, true)
        });

        const diskCtx = document.getElementById("diskChart").getContext("2d");
        diskChart = new Chart(diskCtx, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "Disk %",
                        data: [],
                        borderColor: COLORS.disk.start,
                        backgroundColor: "transparent",
                        fill: false,
                        yAxisID: "y"
                    },
                    {
                        label: "Read",
                        data: [],
                        borderColor: "#10b981", // Emerald
                        backgroundColor: "transparent",
                        fill: false,
                        yAxisID: "y1",
                        borderWidth: 1.2,
                        pointRadius: 0
                    },
                    {
                        label: "Write",
                        data: [],
                        borderColor: "#ef4444", // Red
                        backgroundColor: "transparent",
                        fill: false,
                        yAxisID: "y1",
                        borderWidth: 1.2,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                ...chartOptions("Disk", false, true),
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: makeLegend({
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } }
                    }),
                    tooltip: getTooltipConfig((ctx) => {
                        const val = ctx.parsed.y;
                        if (val === null) return null;
                        let labelText = "";
                        if (ctx.dataset.yAxisID === "y") {
                            labelText = `Usage: ${val.toFixed(1)}%`;
                        } else {
                            labelText = `${ctx.dataset.label}: ${val.toFixed(1)} MB/s`;
                        }
                        return formatTooltipLabel(ctx, labelText);
                    })
                },
                scales: {
                    x: {
                        type: "time",
                        time: { tooltipFormat: "PPpp" },
                        grid: { color: getGridColor(), drawBorder: false },
                        ticks: { color: "#64748b", font: { family: "'Inter', sans-serif", size: 10 }, maxRotation: 0, autoSkipPadding: 20, maxTicksLimit: 8 }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        max: 100,
                        title: { display: true, text: '% Usage', font: { size: 10 } },
                        grid: { color: getGridColor(), drawBorder: false },
                        ticks: { color: "#64748b", font: { size: 10 }, callback: val => val + "%" }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        title: { display: true, text: 'Speed (MB/s)', font: { size: 10 } },
                        grid: { drawOnChartArea: false }, // Prevent gridline overlap
                        ticks: { color: "#64748b", font: { size: 10 }, callback: val => val.toFixed(1) + " MB" }
                    }
                }
            }
        });

        const diskIopsCtx = document.getElementById("diskIopsChart").getContext("2d");
        diskIopsChart = new Chart(diskIopsCtx, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "Read IOPS",
                        data: [],
                        borderColor: "#8b5cf6", // Violet
                        backgroundColor: "transparent",
                        fill: false,
                        yAxisID: "y",
                        borderWidth: 1.2,
                        pointRadius: 0
                    },
                    {
                        label: "Write IOPS",
                        data: [],
                        borderColor: "#f59e0b", // Amber
                        backgroundColor: "transparent",
                        fill: false,
                        yAxisID: "y",
                        borderWidth: 1.2,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                ...chartOptions("IOPS", false, true),
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: makeLegend({
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } }
                    }),
                    tooltip: getTooltipConfig((ctx) => {
                        const val = ctx.parsed.y;
                        if (val === null) return null;
                        const labelText = `${ctx.dataset.label}: ${Math.round(val)}`;
                        return formatTooltipLabel(ctx, labelText);
                    })
                },
                scales: {
                    x: {
                        type: "time",
                        time: { tooltipFormat: "PPpp" },
                        grid: { color: getGridColor(), drawBorder: false },
                        ticks: { color: "#64748b", font: { family: "'Inter', sans-serif", size: 10 }, maxRotation: 0, autoSkipPadding: 20, maxTicksLimit: 8 }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        suggestedMax: 10,
                        title: { display: true, text: 'Operations/sec', font: { size: 10 } },
                        grid: { color: getGridColor(), drawBorder: false },
                        ticks: { color: "#64748b", font: { size: 10 }, callback: val => Math.round(val) }
                    }
                }
            }
        });

        // ─── Daily Network Payload Chart ────────────────────────────────────
        const payloadDailyCanvas = document.getElementById("payloadDailyChart");
        if (payloadDailyCanvas) {
            const payloadDailyCtx = payloadDailyCanvas.getContext("2d");
            payloadDailyChart = new Chart(payloadDailyCtx, {
                type: "line",
                data: {
                    datasets: [
                        {
                            label: "Download",
                            data: [],
                            borderColor: "#0ea5e9",
                            backgroundColor: createGradient(payloadDailyCtx, "#0ea5e9", "#0284c7", 0.15),
                            fill: true,
                            tension: 0.2,
                            pointRadius: 4,
                            pointHoverRadius: 6,
                            pointBackgroundColor: "#0ea5e9",
                            borderWidth: 2
                        },
                        {
                            label: "Upload",
                            data: [],
                            borderColor: "#10b981",
                            backgroundColor: createGradient(payloadDailyCtx, "#10b981", "#059669", 0.15),
                            fill: true,
                            tension: 0.2,
                            pointRadius: 4,
                            pointHoverRadius: 6,
                            pointBackgroundColor: "#10b981",
                            borderWidth: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: makeLegend({
                            display: true,
                            position: 'top',
                            align: 'end',
                            labels: { boxWidth: 12, usePointStyle: true, font: { size: 10 } }
                        }),
                        tooltip: getTooltipConfig((ctx) => {
                            const val = ctx.parsed.y;
                            if (val === null) return null;
                            let formattedVal = "";
                            if (val >= 1024 * 1024) {
                                formattedVal = (val / (1024 * 1024)).toFixed(2) + " PB";
                            } else if (val >= 1024) {
                                formattedVal = (val / 1024).toFixed(2) + " TB";
                            } else {
                                formattedVal = val.toFixed(2) + " GB";
                            }
                            return formatTooltipLabel(ctx, `${ctx.dataset.label}: ${formattedVal}`);
                        })
                    },
                    scales: {
                        x: {
                            type: "time",
                            time: {
                                unit: 'day',
                                displayFormats: {
                                    day: 'MM/dd 00:00'
                                },
                                tooltipFormat: "yyyy-MM-dd"
                            },
                            grid: { color: getGridColor(), drawBorder: false },
                            ticks: {
                                color: "#64748b",
                                font: { family: "'Inter', sans-serif", size: 10 },
                                maxRotation: 0,
                                autoSkipPadding: 20
                            }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            beginAtZero: true,
                            min: 0,
                            suggestedMin: 0,
                            title: { display: true, text: 'Payload', font: { size: 10 } },
                            grid: { color: getGridColor(), drawBorder: false },
                            ticks: {
                                color: "#64748b",
                                font: { size: 10 },
                                callback: function(val) {
                                    if (val >= 1024 * 1024) return (val / (1024 * 1024)).toFixed(1) + " PB";
                                    if (val >= 1024) return (val / 1024).toFixed(1) + " TB";
                                    return val.toFixed(0) + " GB";
                                }
                            }
                        }
                    }
                }
            });

            const pIfaceSel = document.getElementById("payloadChartIfaceSelect");
            if (pIfaceSel) {
                pIfaceSel.addEventListener("change", updateDailyPayloadChart);
            }
            const pDaysSel = document.getElementById("payloadChartDaysSelect");
            if (pDaysSel) {
                pDaysSel.addEventListener("change", fetchDailyPayload);
            }
        }

        const netCtx = document.getElementById("netChart").getContext("2d");
        netChart = new Chart(netCtx, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "Upload",
                        data: [],
                        borderColor: COLORS.netSent.start,
                        backgroundColor: createGradient(netCtx, COLORS.netSent.start, COLORS.netSent.end, 0.1),
                        fill: true
                    },
                    {
                        label: "Download",
                        data: [],
                        borderColor: COLORS.netRecv.start,
                        backgroundColor: createGradient(netCtx, COLORS.netRecv.start, COLORS.netRecv.end, 0.1),
                        fill: true
                    }
                ]
            },
            options: chartOptions("Network", false, true)
        });

        // Apply saved max from localStorage
        const savedMax = localStorage.getItem("netMaxMbps");
        if (savedMax) {
            const el = document.getElementById("netMaxMbps");
            if (el) el.value = savedMax;
        }
        
        const savedAuto = localStorage.getItem("netChartAutoMax");
        if (savedAuto) {
            const autoEl = document.getElementById("netChartAutoMax");
            if (autoEl) autoEl.checked = (savedAuto === "true");
        }

        applyNetMax();

        // Listen for max input changes (fires instantly on typing)
        document.getElementById("netMaxMbps").addEventListener("input", () => {
            const max = getNetMax();
            localStorage.setItem("netMaxMbps", max);
            
            // if user manually types, uncheck auto
            const autoEl = document.getElementById("netChartAutoMax");
            if (autoEl && autoEl.checked) {
                autoEl.checked = false;
                localStorage.setItem("netChartAutoMax", "false");
            }
            // Just update the Y axis scale — no need to re-render data
            applyNetMax();
        });
        
        document.getElementById("netChartAutoMax").addEventListener("change", (e) => {
            localStorage.setItem("netChartAutoMax", e.target.checked);
            applyNetMax();
        });

        document.getElementById("netChartIfaceSelect").addEventListener("change", () => {
            // Only re-filter the net chart data — fast, no API call needed
            if (window.lastMetricsJson && window.lastMetricsJson.data) {
                updateNetChart(window.lastMetricsJson.data);
                // Also update payload display for the new interface selection
                updatePayloadDisplay();
            }
        });

        // ─── Connections chart ────────────────────────────────────────────
        const connCtx = document.getElementById("connChart").getContext("2d");
        connChart = new Chart(connCtx, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "TCP",
                        data: [],
                        borderColor: COLORS.tcp.start,
                        backgroundColor: createGradient(connCtx, COLORS.tcp.start, COLORS.tcp.end, 0.12),
                        fill: true
                    },
                    {
                        label: "UDP",
                        data: [],
                        borderColor: COLORS.udp.start,
                        backgroundColor: createGradient(connCtx, COLORS.udp.start, COLORS.udp.end, 0.12),
                        fill: true
                    }
                ]
            },
            options: connChartOptions()
        });

        const connAutoEl = document.getElementById("connChartAutoMax");
        if (connAutoEl) {
            connAutoEl.addEventListener("change", (e) => {
                if (e.target.checked) {
                    connChart.options.scales.y.max = null;
                }
                if (window.lastMetricsJson && window.lastMetricsJson.data) {
                    updateConnChart(window.lastMetricsJson.data);
                }
            });
        }

        // Listen for interface selector changes
        document.getElementById("connIfaceSelect").addEventListener("change", () => {
            updateConnChart(lastConnData);
        });
    }

    function connChartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            onHover(event, activeElements, chart) {
                const nativeEvt = event.native || event;
                const nearest = chart.getElementsAtEventForMode(nativeEvt, 'nearest', { intersect: false }, true);
                const idx = (nearest && nearest[0]) ? nearest[0].datasetIndex : -1;
                
                chart.data.datasets.forEach((dataset, i) => {
                    if (typeof dataset._origBorderWidth === 'undefined') {
                        dataset._origBorderWidth = dataset.borderWidth || 1.2;
                    }
                    const isHovered = (idx >= 0 && i === idx);
                    dataset.borderWidth = isHovered ? (dataset._origBorderWidth + 1) : dataset._origBorderWidth;
                });
                
                if (_legendHover.get(chart) !== idx) {
                    if (idx >= 0) {
                        _legendHover.set(chart, idx);
                    } else {
                        _legendHover.delete(chart);
                    }
                }
                
                if (!chart.canvas._hasMouseOutListener) {
                    chart.canvas._hasMouseOutListener = true;
                    chart.canvas.addEventListener('mouseout', () => {
                        chart.data.datasets.forEach((ds) => {
                            if (typeof ds._origBorderWidth !== 'undefined') {
                                ds.borderWidth = ds._origBorderWidth;
                            }
                        });
                        _legendHover.delete(chart);
                        chart.update('none');
                    });
                }
                
                chart.update('none');
            },
            plugins: {
                legend: makeLegend({
                    display: true,
                    position: "top",
                    labels: {
                        color: "#475569",
                        font: { family: "'Inter', sans-serif", size: 11 },
                        boxWidth: 12,
                        padding: 12
                    }
                }),
                tooltip: getTooltipConfig((ctx) => {
                    const val = ctx.parsed.y;
                    const labelText = `${ctx.dataset.label}: ${val !== null && val !== undefined ? Math.round(val) : 0}`;
                    return formatTooltipLabel(ctx, labelText);
                })
            },
            scales: {
                x: {
                    type: "time",
                    time: { tooltipFormat: "PPpp" },
                    grid: { color: getGridColor(), drawBorder: false },
                    ticks: {
                        color: "#64748b",
                        font: { family: "'Inter', sans-serif", size: 10 },
                        maxRotation: 0,
                        autoSkipPadding: 20,
                        maxTicksLimit: 8
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: getGridColor(), drawBorder: false },
                    ticks: {
                        color: "#64748b",
                        font: { family: "'Inter', sans-serif", size: 10 },
                        maxTicksLimit: 6
                    }
                }
            },
            elements: {
                point: { radius: 0, hoverRadius: 4, hitRadius: 20 },
                line: { tension: 0.4, borderWidth: 1.2 }
            },
            animation: { duration: 800, easing: "easeInOutQuart" }
        };
    }

    function applyNetMax() {
        const isAutoMax = document.getElementById("netChartAutoMax") && document.getElementById("netChartAutoMax").checked;
        if (isAutoMax) {
            netChart.options.scales.y.max = null;
            netChart.options.scales.y.ticks.stepSize = null;
        } else {
            const max = getNetMax();
            netChart.options.scales.y.max = max;
            netChart.options.scales.y.ticks.stepSize = max > 200 ? 50 : 10;
        }
        netChart.update("none");
    }

    // ─── Data Fetching ───────────────────────────────────────────────────────

    async function fetchCurrent() {
        try {
            const res = await fetch("/api/current");
            if (res.status === 401) {
                window.location.reload();
                return;
            }
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.cpu && data.ram) {
                updateCurrentStats(data);
            }
        } catch (err) {
            console.error("Failed to fetch current stats:", err);
            const sub = document.getElementById("headerSubtitle");
            if (sub && sub.textContent === "Connecting...") {
                sub.textContent = "Connection error...";
            }
        }
    }

    async function fetchMetrics() {
        try {
            let url;
            if (customSeconds !== null) {
                url = `/api/metrics?seconds=${customSeconds}`;
            } else {
                url = `/api/metrics?range=${currentRange}`;
            }
            const res = await fetch(url);
            if (res.status === 401) {
                window.location.reload();
                return;
            }
            if (!res.ok) return;
            const json = await res.json();
            if (json && json.data) {
                window.lastMetricsJson = json; // store globally for the updateCharts function
                updateCharts(json.data);
                if (typeof updatePayloadDisplay === 'function') updatePayloadDisplay();
            }
        } catch (err) {
            console.error("Failed to fetch metrics:", err);
        }
    }

    // ─── Update Current Stats ────────────────────────────────────────────────

    function updateCurrentStats(data) {
        if (!data || !data.cpu || !data.ram || !data.disk) return;

        // Visual Threshold Alerts
        const cpuCard = document.querySelector(".card-cpu") || document.getElementById("cpuChart")?.closest(".card");
        if (cpuCard) {
            if (data.cpu.percent >= 90) {
                cpuCard.classList.add("card-threshold-danger");
                cpuCard.classList.remove("card-threshold-warning");
            } else if (data.cpu.percent >= 80) {
                cpuCard.classList.add("card-threshold-warning");
                cpuCard.classList.remove("card-threshold-danger");
            } else {
                cpuCard.classList.remove("card-threshold-warning", "card-threshold-danger");
            }
        }

        const ramCard = document.querySelector(".card-ram") || document.getElementById("ramChart")?.closest(".card");
        if (ramCard) {
            if (data.ram.percent >= 90) {
                ramCard.classList.add("card-threshold-danger");
                ramCard.classList.remove("card-threshold-warning");
            } else if (data.ram.percent >= 80) {
                ramCard.classList.add("card-threshold-warning");
                ramCard.classList.remove("card-threshold-danger");
            } else {
                ramCard.classList.remove("card-threshold-warning", "card-threshold-danger");
            }
        }
        // Apply features flags
        if (data.features) {
            const hasV2ray = data.features.v2ray !== false;
            const btnV2ray = document.getElementById("btnV2rayOpen");
            if (btnV2ray) {
                btnV2ray.style.display = hasV2ray ? "flex" : "none";
            }
            if (!hasV2ray) {
                const overlay = document.getElementById('v2rayOverlay');
                if (overlay && !overlay.classList.contains('hidden')) {
                    overlay.classList.add('hidden');
                }
            }
        }

        // Hostname Badge
        if (data.system && data.system.hostname) {
            const hostEl = document.getElementById("serverHostname");
            if (hostEl) {
                hostEl.textContent = data.system.hostname;
                hostEl.style.display = "inline-block";
            }
        }

        // Check for updates
        if (data.system && data.system.version) {
            checkForUpdates(data.system.version);
        }

        // Subtitle
        document.getElementById("headerSubtitle").textContent =
            `Last updated: ${new Date().toLocaleTimeString()}`;

        // Panel Version
        if (data.system && data.system.version) {
            const verEl = document.getElementById("panelVersion");
            if (verEl) verEl.textContent = "v" + data.system.version;
        }

        // CPU Gauge
        setGauge("cpuGaugeFill", data.cpu.percent);
        animateNumber("cpuPercent", data.cpu.percent);
        document.getElementById("cpuCores").textContent = data.cpu.cores + " cores";
        document.getElementById("cpuFreq").textContent = data.cpu.freq_mhz + " MHz";

        const modelEl = document.getElementById("cpuModelName");
        if (modelEl && data.cpu.model) {
            // Clean up long strings like "AMD EPYC 7002-core Processor"
            let niceName = data.cpu.model.replace(" Processor", "").replace("(R)", "").replace("(TM)", "").replace(" CPU", "");
            modelEl.textContent = niceName.trim();
        }

        // Per-Core CPU Cylinders
        if (data.cpu.per_core) {
            renderCpuCores(data.cpu.per_core);
        }

        // RAM Gauge
        setGauge("ramGaugeFill", data.ram.percent);
        animateNumber("ramPercent", data.ram.percent);
        document.getElementById("ramTotal").textContent = data.ram.total_gb + " GB";
        document.getElementById("ramUsed").textContent = data.ram.used_gb + " GB";
        document.getElementById("ramFree").textContent = data.ram.free_gb + " GB";
        document.getElementById("ramShared").textContent = data.ram.shared_gb + " GB";
        document.getElementById("ramBuffCache").textContent = data.ram.buff_cache_gb + " GB";
        document.getElementById("ramAvailable").textContent = data.ram.available_gb + " GB";
        if (data.swap) {
            document.getElementById("ramSwap").textContent = `${data.swap.used_gb} GB / ${data.swap.total_gb} GB`;
        }

        // Disk Gauge
        setGauge("diskGaugeFill", data.disk.percent);
        animateNumber("diskPercent", data.disk.percent);
        document.getElementById("diskUsed").textContent = data.disk.used_gb + " GB";
        document.getElementById("diskFree").textContent = data.disk.free_gb + " GB";

        // Disk I/O
        const formatDiskSpeed = (bps) => bps > 1_048_576 ? (bps / 1_048_576).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
        document.getElementById("diskSpeed").textContent = `${formatDiskSpeed(data.disk.read_bps)} / ${formatDiskSpeed(data.disk.write_bps)}`;
        document.getElementById("diskIops").textContent = `${data.disk.read_iops} / ${data.disk.write_iops}`;

        // Network — use selected NIC data from per_nic, fallback to default
        const nicKey = selectedNic || (data.network && data.network.default_nic) || Object.keys(data.per_nic || {})[0] || '';
        let nicData = data.network || {};  // default fallback
        if (nicKey && data.per_nic && data.per_nic[nicKey]) {
            nicData = data.per_nic[nicKey];
        }

        const sentBps = nicData.sent_bps || 0;
        const recvBps = nicData.recv_bps || 0;
        document.getElementById("netSent").textContent = formatBps(sentBps);
        document.getElementById("netRecv").textContent = formatBps(recvBps);

        // Live Packets/sec
        document.getElementById("livePps").innerHTML = `<span style="color:#059669">↑${(nicData.sent_pps || 0).toLocaleString()}</span> &nbsp; <span style="color:#0891b2">↓${(nicData.recv_pps || 0).toLocaleString()}</span>`;

        // Save Boot Totals for the selected NIC
        window.lastBootTotals = {
            sent_gb: nicData.sent_gb || nicData.sent_gb || 0,
            recv_gb: nicData.recv_gb || nicData.recv_gb || 0
        };
        if (typeof updatePayloadDisplay === 'function') {
            const sel = document.getElementById("payloadRange");
            if (sel && sel.value === "boot") {
                updatePayloadDisplay();
            }
        }

        // Live TCP/UDP counts (selected NIC)
        if (data.connections && data.connections[nicKey]) {
            document.getElementById("liveTcpUdp").textContent =
                `${data.connections[nicKey].tcp.toLocaleString()} / ${data.connections[nicKey].udp.toLocaleString()}`;
        } else if (data.connections && data.connections.Total) {
            document.getElementById("liveTcpUdp").textContent =
                `${data.connections.Total.tcp.toLocaleString()} / ${data.connections.Total.udp.toLocaleString()}`;
        }

        // Load
        document.getElementById("load1").textContent = data.system.load_avg_1m;
        document.getElementById("load5").textContent = data.system.load_avg_5m;
        const load15El = document.getElementById("load15");
        if (load15El) load15El.textContent = data.system.load_avg_15m;

        // Uptime
        document.getElementById("uptimeText").textContent = formatUptime(data.system.uptime_seconds);

        // Public IPs (only update when value changes to avoid flicker)
        if (data.public_ips) {
            const ipv4El = document.getElementById("publicIpv4");
            const ipv6El = document.getElementById("publicIpv6");
            if (ipv4El && data.public_ips.ipv4 && ipv4El.textContent !== data.public_ips.ipv4) {
                ipv4El.textContent = data.public_ips.ipv4;
            }
            if (ipv6El && data.public_ips.ipv6 && ipv6El.textContent !== data.public_ips.ipv6) {
                ipv6El.textContent = data.public_ips.ipv6;
            }
        }
    }

    function setGauge(elementId, percent) {
        const el = document.getElementById(elementId);
        if (!el) return;
        const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;
        el.style.strokeDashoffset = offset;
    }

    function animateNumber(elementId, targetValue) {
        const el = document.getElementById(elementId);
        if (!el) return;
        // Direct update for 1s refresh — no animation lag
        el.textContent = Math.round(targetValue);
    }

    // ─── Update Charts ───────────────────────────────────────────────────────

    function updateCharts(data) {
        if (!data || data.length === 0) {
            // Show empty state
            document.getElementById("cpuAvgBadge").textContent = "No data yet";
            document.getElementById("ramAvgBadge").textContent = "No data yet";
            document.getElementById("diskAvgBadge").textContent = "No data yet";
            document.getElementById("netAvgBadge").textContent = "No data yet";
            return;
        }

        const timestamps = data.map(d => new Date(d.t * 1000));

        // Calculate explicit min/max bounds based on the selected range
        // Use the latest data point from the server as the max bound, falling back to Date.now()
        let maxMs = Date.now();
        if (timestamps.length > 0) {
            maxMs = Math.max(Date.now(), timestamps[timestamps.length - 1].getTime());
        }
        const rangeMs = (customSeconds !== null) ? (customSeconds * 1000) : (RANGE_MS[currentRange] || 3600000);
        const minMs = maxMs - rangeMs;

        // CPU Max configuration
        const isCpuAuto = document.getElementById("cpuChartAutoMax") && document.getElementById("cpuChartAutoMax").checked;
        if (isCpuAuto) {
            cpuChart.options.scales.y.max = null;
        } else {
            const savedCpuMax = localStorage.getItem("cpuMaxPercent");
            if (savedCpuMax && !isNaN(parseInt(savedCpuMax, 10))) {
                cpuChart.options.scales.y.max = parseInt(savedCpuMax, 10);
            } else {
                const manualCpuMax = parseInt(document.getElementById("cpuDynamicMax").value, 10) || 70;
                cpuChart.options.scales.y.max = manualCpuMax;
            }
        }

        // CPU
        cpuChart.options.scales.x.min = minMs;
        cpuChart.options.scales.x.max = maxMs;
        const cpuAvgData = data.map((d, i) => ({ x: timestamps[i], y: d.cpu }));
        cpuChart.data.datasets[0].data = movingAverage(cpuAvgData, getSmoothWindow());

        let numCores = 0;
        for (const d of data) {
            if (d.extra && d.extra.cpu_cores) {
                numCores = Math.max(numCores, d.extra.cpu_cores.length);
            }
        }
        if (numCores > 0) {
            const corePalette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#8b5cf6", "#d946ef", "#f43f5e", "#ff8a65", "#ba68c8"];

            // Ensure cpuChart has enough datasets
            while (cpuChart.data.datasets.length <= numCores) {
                const coreIndex = cpuChart.data.datasets.length - 1;
                const color = corePalette[coreIndex % corePalette.length];
                cpuChart.data.datasets.push({
                    label: `Core ${coreIndex}`,
                    data: [],
                    borderColor: color,
                    backgroundColor: 'transparent',
                    fill: false,
                    borderWidth: 1.2,
                    pointRadius: 0
                });
            }

            // Populate core data
            for (let j = 0; j < numCores; j++) {
                const coreDataPoints = [];
                for (let i = 0; i < data.length; i++) {
                    const d = data[i];
                    if (d.extra && d.extra.cpu_cores && d.extra.cpu_cores.length > j) {
                        coreDataPoints.push({ x: timestamps[i], y: d.extra.cpu_cores[j] });
                    } else {
                        coreDataPoints.push({ x: timestamps[i], y: null });
                    }
                }
                cpuChart.data.datasets[j + 1].data = movingAverage(coreDataPoints, getSmoothWindow());
            }
        }
        cpuChart.update("none");
        const cpuVals = data.map(d => d.cpu);
        const cpuMin = Math.min(...cpuVals).toFixed(1);
        const cpuMax = Math.max(...cpuVals).toFixed(1);
        const cpuAvg = (cpuVals.reduce((s, v) => s + v, 0) / cpuVals.length).toFixed(1);
        document.getElementById("cpuAvgBadge").textContent = `Min: ${cpuMin}% | Max: ${cpuMax}% | Avg: ${cpuAvg}%`;

        // Load Average
        loadChart.options.scales.x.min = minMs;
        loadChart.options.scales.x.max = maxMs;

        const load1Data = [];
        const load5Data = [];
        const load15Data = [];

        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const t = timestamps[i];
            if (d.extra && d.extra.load_avg && d.extra.load_avg.length === 3) {
                load1Data.push({ x: t, y: d.extra.load_avg[0] });
                load5Data.push({ x: t, y: d.extra.load_avg[1] });
                load15Data.push({ x: t, y: d.extra.load_avg[2] });
            } else {
                load1Data.push({ x: t, y: null });
                load5Data.push({ x: t, y: null });
                load15Data.push({ x: t, y: null });
            }
        }

        loadChart.data.datasets[0].data = movingAverage(load1Data, getSmoothWindow());
        loadChart.data.datasets[1].data = movingAverage(load5Data, getSmoothWindow());
        loadChart.data.datasets[2].data = movingAverage(load15Data, getSmoothWindow());

        loadChart.update("none");

        // Update load average badge in the card header
        const loadAvgEl = document.getElementById("loadAvgBadge");
        if (loadAvgEl && data.length > 0) {
            const l1Vals = data.filter(d => d.extra && d.extra.load_avg && d.extra.load_avg.length === 3).map(d => d.extra.load_avg[0]);
            const l5Vals = data.filter(d => d.extra && d.extra.load_avg && d.extra.load_avg.length === 3).map(d => d.extra.load_avg[1]);
            const l15Vals = data.filter(d => d.extra && d.extra.load_avg && d.extra.load_avg.length === 3).map(d => d.extra.load_avg[2]);
            if (l15Vals.length > 0) {
                const l15Min = Math.min(...l15Vals).toFixed(2);
                const l15Max = Math.max(...l15Vals).toFixed(2);
                const l1Avg = (l1Vals.reduce((s, v) => s + v, 0) / l1Vals.length).toFixed(2);
                const l5Avg = (l5Vals.reduce((s, v) => s + v, 0) / l5Vals.length).toFixed(2);
                const l15Avg = (l15Vals.reduce((s, v) => s + v, 0) / l15Vals.length).toFixed(2);
                loadAvgEl.textContent = `Min/Max (15m): ${l15Min}/${l15Max} | Avg: ${l1Avg}/${l5Avg}/${l15Avg}`;
            } else {
                loadAvgEl.textContent = "Avg: —";
            }
        }

        // RAM
        ramChart.options.scales.x.min = minMs;
        ramChart.options.scales.x.max = maxMs;
        const ramData = data.map((d, i) => ({ x: timestamps[i], y: d.ram }));
        ramChart.data.datasets[0].data = movingAverage(ramData, getSmoothWindow());

        // Process advanced RAM metrics if extra exists
        if (data.some(d => d.extra && d.extra.ram_free_gb !== undefined)) {
            const ramMetrics = [
                { label: "Free %", key: "ram_free_gb", color: "#22c55e" },
                { label: "Shared %", key: "ram_shared_gb", color: "#eab308" },
                { label: "Buff/Cache %", key: "ram_buff_cache_gb", color: "#0ea5e9" },
                { label: "Available %", key: "ram_available_gb", color: "#14b8a6" },
                { label: "Swap %", key: "swap_used_gb", color: "#d946ef", forceTotalKey: "swap_total_gb" } // using swap percent if possible
            ];

            while (ramChart.data.datasets.length <= ramMetrics.length) {
                const metricIndex = ramChart.data.datasets.length - 1;
                const metricDef = ramMetrics[metricIndex];
                ramChart.data.datasets.push({
                    label: metricDef.label,
                    data: [],
                    borderColor: metricDef.color,
                    backgroundColor: 'transparent',
                    fill: false,
                    borderWidth: 1.2,
                    pointRadius: 0
                });
            }

            for (let j = 0; j < ramMetrics.length; j++) {
                const metricDef = ramMetrics[j];
                const dataPoints = [];
                for (let i = 0; i < data.length; i++) {
                    const d = data[i];
                    if (d.extra && d.extra[metricDef.key] !== undefined) {
                        let pct = 0;
                        if (metricDef.key === "swap_used_gb") {
                            const swapTotal = d.extra.swap_total_gb || 0;
                            if (swapTotal > 0) {
                                pct = (d.extra[metricDef.key] / swapTotal) * 100;
                            }
                        } else {
                            if (d.ram_total > 0) {
                                pct = (d.extra[metricDef.key] / d.ram_total) * 100;
                            }
                        }
                        dataPoints.push({ x: timestamps[i], y: pct.toFixed(1) });
                    } else {
                        dataPoints.push({ x: timestamps[i], y: null });
                    }
                }
                ramChart.data.datasets[j + 1].data = movingAverage(dataPoints, getSmoothWindow());
            }
        }

        ramChart.update("none");
        const ramVals = data.map(d => d.ram);
        const ramMin = Math.min(...ramVals).toFixed(1);
        const ramMax = Math.max(...ramVals).toFixed(1);
        const ramAvg = (ramVals.reduce((s, v) => s + v, 0) / ramVals.length).toFixed(1);
        document.getElementById("ramAvgBadge").textContent = `Min: ${ramMin}% | Max: ${ramMax}% | Avg: ${ramAvg}%`;

        // Disk
        diskChart.options.scales.x.min = minMs;
        diskChart.options.scales.x.max = maxMs;
        const diskData = data.map((d, i) => ({ x: timestamps[i], y: d.disk }));

        // Extract and process Disk I/O metrics
        const diskReadData = [];
        const diskWriteData = [];
        const diskReadIopsData = [];
        const diskWriteIopsData = [];

        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            if (d.extra && d.extra.disk_read_bps !== undefined) {
                // Convert bytes/sec to MB/sec
                const readMBps = d.extra.disk_read_bps / 1_048_576;
                const writeMBps = d.extra.disk_write_bps / 1_048_576;
                diskReadData.push({ x: timestamps[i], y: readMBps });
                diskWriteData.push({ x: timestamps[i], y: writeMBps });
                diskReadIopsData.push({ x: timestamps[i], y: d.extra.disk_read_iops || 0 });
                diskWriteIopsData.push({ x: timestamps[i], y: d.extra.disk_write_iops || 0 });
            } else {
                diskReadData.push({ x: timestamps[i], y: null });
                diskWriteData.push({ x: timestamps[i], y: null });
                diskReadIopsData.push({ x: timestamps[i], y: null });
                diskWriteIopsData.push({ x: timestamps[i], y: null });
            }
        }

        // Calculate dynamic max for disk speed (Y1) with 20% padding
        let maxDiskSpd = 1; // start with an absolute minimum scale
        for (let i = 0; i < diskReadData.length; i++) {
            if (diskReadData[i].y > maxDiskSpd) maxDiskSpd = diskReadData[i].y;
            if (diskWriteData[i].y > maxDiskSpd) maxDiskSpd = diskWriteData[i].y;
        }
        diskChart.options.scales.y1.max = maxDiskSpd * 1.2;

        const sw = getSmoothWindow();
        diskChart.data.datasets[0].data = movingAverage(diskData, sw);
        diskChart.data.datasets[1].data = movingAverage(diskReadData, sw);
        diskChart.data.datasets[2].data = movingAverage(diskWriteData, sw);
        diskChart.update("none");

        // Calculate dynamic max for disk IOPS with 20% padding
        let maxIops = 10;
        for (let i = 0; i < diskReadIopsData.length; i++) {
            if (diskReadIopsData[i].y > maxIops) maxIops = diskReadIopsData[i].y;
            if (diskWriteIopsData[i].y > maxIops) maxIops = diskWriteIopsData[i].y;
        }
        diskIopsChart.options.scales.y.max = maxIops * 1.2;

        diskIopsChart.options.scales.x.min = minMs;
        diskIopsChart.options.scales.x.max = maxMs;

        diskIopsChart.data.datasets[0].data = movingAverage(diskReadIopsData, getSmoothWindow());
        diskIopsChart.data.datasets[1].data = movingAverage(diskWriteIopsData, getSmoothWindow());
        diskIopsChart.update("none");

        const diskVals = data.map(d => d.disk);
        const diskMin = Math.min(...diskVals).toFixed(1);
        const diskMax = Math.max(...diskVals).toFixed(1);
        const diskAvg = (diskVals.reduce((s, v) => s + v, 0) / diskVals.length).toFixed(1);
        document.getElementById("diskAvgBadge").textContent = `Min: ${diskMin}% | Max: ${diskMax}% | Avg: ${diskAvg}%`;

        const iopsBadgeEl = document.getElementById("iopsAvgBadge");
        if (iopsBadgeEl && diskReadIopsData.length > 0) {
            const rVals = diskReadIopsData.map(d => d.y).filter(y => y !== null);
            const wVals = diskWriteIopsData.map(d => d.y).filter(y => y !== null);
            if (rVals.length > 0 && wVals.length > 0) {
                const rMax = Math.round(Math.max(...rVals));
                const rAvg = Math.round(rVals.reduce((s, v) => s + v, 0) / rVals.length);
                const wMax = Math.round(Math.max(...wVals));
                const wAvg = Math.round(wVals.reduce((s, v) => s + v, 0) / wVals.length);
                iopsBadgeEl.textContent = `Read Max/Avg: ${rMax}/${rAvg} | Write Max/Avg: ${wMax}/${wAvg}`;
            }
        }

        // Network — delegate to dedicated lightweight updater
        updateNetChart(data, timestamps, minMs, maxMs);

        // Connections — store and update
        lastConnData = data;
        updateConnChart(data);
    }

    // ─── Net Chart Updater (fast, no full re-render) ─────────────────────────

    function updateNetChart(data, timestamps, minMs, maxMs) {
        if (!data || data.length === 0) return;

        // Use cached timestamps/bounds if not provided (called from iface-selector)
        if (!timestamps) timestamps = data.map(d => new Date(d.t * 1000));
        if (minMs === undefined || maxMs === undefined) {
            maxMs = Date.now();
            if (timestamps.length > 0) maxMs = Math.max(Date.now(), timestamps[timestamps.length - 1].getTime());
            const rangeMs = (customSeconds !== null) ? (customSeconds * 1000) : (RANGE_MS[currentRange] || 3600000);
            minMs = maxMs - rangeMs;
        }

        // Populate Network I/O Interface Dropdown
        const netChartIfaceSel = document.getElementById("netChartIfaceSelect");
        if (netChartIfaceSel) {
            const currentNetIface = netChartIfaceSel.value;
            const availableNetIfaces = new Set();
            data.forEach(d => {
                if (d.extra && d.extra.nic_rates) {
                    Object.keys(d.extra.nic_rates).forEach(k => availableNetIfaces.add(k));
                }
                if (d.conns) {
                    Object.keys(d.conns).forEach(k => {
                        if (k !== 'Total' && k !== 'other' && k !== 'lo') availableNetIfaces.add(k);
                    });
                }
            });
            if (window.discoveredInterfaces && Array.isArray(window.discoveredInterfaces)) {
                window.discoveredInterfaces.forEach(ifName => availableNetIfaces.add(ifName));
            }
            if (availableNetIfaces.size === 0) {
                availableNetIfaces.add(window.detectedDefaultNic || 'ens3');
            }
            const sorted = Array.from(availableNetIfaces).sort();
            const oldNetOpts = Array.from(netChartIfaceSel.options).map(o => o.value);
            if (sorted.length > 0 && oldNetOpts.join(",") !== sorted.join(",")) {
                netChartIfaceSel.innerHTML = '';
                sorted.forEach(iface => {
                    const opt = document.createElement("option");
                    opt.value = iface;
                    opt.textContent = iface;
                    netChartIfaceSel.appendChild(opt);
                });
                const defaultIface = (currentNetIface && sorted.includes(currentNetIface)) ? currentNetIface :
                                     (window.detectedDefaultNic && sorted.includes(window.detectedDefaultNic)) ? window.detectedDefaultNic :
                                     sorted.includes('ens3') ? 'ens3' :
                                     sorted[0] || 'ens3';
                netChartIfaceSel.value = defaultIface;
            }
        }

        const selectedNetIface = (netChartIfaceSel && netChartIfaceSel.value) ? netChartIfaceSel.value : (window.detectedDefaultNic || 'ens3');

        // nic_rates.sent_bps is BITS/sec (backend *8), so /1e6 = Mbps
        // d.net_sent is BYTES/sec, so *8/1e6 = Mbps
        const toMbpsFromBytes = (bytesSec) => (bytesSec * 8) / 1_000_000;
        const toMbpsFromBits  = (bitsSec)  => bitsSec / 1_000_000;

        netChart.options.scales.x.min = minMs;
        netChart.options.scales.x.max = maxMs;

        let netSentData = [];
        let netRecvData = [];

        const defaultNicName = window.detectedDefaultNic || 'ens3';

        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            if (d.extra && d.extra.nic_rates && d.extra.nic_rates[selectedNetIface]) {
                // nic_rates values are already in bits/sec
                netSentData.push({ x: timestamps[i], y: toMbpsFromBits(d.extra.nic_rates[selectedNetIface].sent_bps || 0) });
                netRecvData.push({ x: timestamps[i], y: toMbpsFromBits(d.extra.nic_rates[selectedNetIface].recv_bps || 0) });
            } else if (!selectedNetIface || selectedNetIface === defaultNicName || selectedNetIface === 'ens3' || selectedNetIface === 'eth0' || selectedNetIface === 'enp1s0' || selectedNetIface === 'Total') {
                // Primary NIC fallback: historical data stored ens3 in top-level net_sent / net_recv (bytes/sec)
                netSentData.push({ x: timestamps[i], y: toMbpsFromBytes(d.net_sent || 0) });
                netRecvData.push({ x: timestamps[i], y: toMbpsFromBytes(d.net_recv || 0) });
            } else {
                // Fallback for secondary NICs when no historical per-NIC data exists — show 0
                netSentData.push({ x: timestamps[i], y: 0 });
                netRecvData.push({ x: timestamps[i], y: 0 });
            }
        }

        const nsw = getSmoothWindow();
        netChart.data.datasets[0].data = movingAverage(netSentData, nsw);
        netChart.data.datasets[1].data = movingAverage(netRecvData, nsw);

        const isAutoMax = document.getElementById("netChartAutoMax") && document.getElementById("netChartAutoMax").checked;
        if (isAutoMax) {
            netChart.options.scales.y.max = null;
            netChart.options.scales.y.ticks.stepSize = null;
        } else {
            const manualMax = parseInt(document.getElementById("netMaxMbps").value, 10) || 120;
            netChart.options.scales.y.max = manualMax;
            netChart.options.scales.y.ticks.stepSize = manualMax > 200 ? 50 : 10;
        }
        netChart.update("none");

        const sentVals = netSentData.map(d => d.y);
        const recvVals = netRecvData.map(d => d.y);
        const sentMin = sentVals.length > 0 ? Math.min(...sentVals).toFixed(1) : "0.0";
        const sentMax = sentVals.length > 0 ? Math.max(...sentVals).toFixed(1) : "0.0";
        const sentAvg = sentVals.length > 0 ? (sentVals.reduce((s, d) => s + d, 0) / sentVals.length).toFixed(1) : "0.0";
        const recvMin = recvVals.length > 0 ? Math.min(...recvVals).toFixed(1) : "0.0";
        const recvMax = recvVals.length > 0 ? Math.max(...recvVals).toFixed(1) : "0.0";
        const recvAvg = recvVals.length > 0 ? (recvVals.reduce((s, d) => s + d, 0) / recvVals.length).toFixed(1) : "0.0";
        const liveValsEl = document.getElementById("netChartLiveVals");
        if (liveValsEl) {
            liveValsEl.innerHTML = `<span style="color:#10b981">Up Min/Max/Avg: ${sentMin}/${sentMax}/${sentAvg} Mbps</span> &nbsp;|&nbsp; <span style="color:#0ea5e9">Down Min/Max/Avg: ${recvMin}/${recvMax}/${recvAvg} Mbps</span>`;
        }
    }
    function updateConnChart(data) {
        if (!data || data.length === 0) return;
        const timestamps = data.map(d => new Date(d.t * 1000));
        const iface = document.getElementById("connIfaceSelect").value || "Total";

        // Populate interface dropdown from data (discover available interfaces)
        const allIfaces = new Set();
        data.forEach(d => {
            if (d.conns) Object.keys(d.conns).forEach(k => allIfaces.add(k));
        });
        const select = document.getElementById("connIfaceSelect");
        const currentOptions = new Set([...select.options].map(o => o.value));
        allIfaces.forEach(name => {
            if (!currentOptions.has(name)) {
                const opt = document.createElement("option");
                opt.value = name;
                opt.textContent = name;
                select.appendChild(opt);
            }
        });
        // Restore selection
        select.value = iface;

        // Extract TCP/UDP data for the selected interface
        const tcpData = data.map((d, i) => {
            const c = d.conns && d.conns[iface];
            return { x: timestamps[i], y: c ? c.tcp : 0 };
        });
        const udpData = data.map((d, i) => {
            const c = d.conns && d.conns[iface];
            return { x: timestamps[i], y: c ? c.udp : 0 };
        });

        // Apply explicit min/max bounds
        const maxMs = Date.now();
        const rangeMs = (customSeconds !== null) ? (customSeconds * 1000) : (RANGE_MS[currentRange] || 3600000);
        const minMs = maxMs - rangeMs;
        connChart.options.scales.x.min = minMs;
        connChart.options.scales.x.max = maxMs;

        const isConnAuto = document.getElementById("connChartAutoMax") && document.getElementById("connChartAutoMax").checked;
        if (isConnAuto) {
            connChart.options.scales.y.max = null;
        } else {
            const peakConn = Math.max(...tcpData.map(d => d.y), ...udpData.map(d => d.y), 10);
            connChart.options.scales.y.max = Math.ceil(peakConn * 1.2);
        }

        const csw = getSmoothWindow();
        connChart.data.datasets[0].data = movingAverage(tcpData, csw);
        connChart.data.datasets[1].data = movingAverage(udpData, csw);
        connChart.update("none");

        // Badge — Min/Max/Avg over timeframe
        const connBadgeEl = document.getElementById("connBadge");
        if (connBadgeEl && tcpData.length > 0) {
            const tcpVals = tcpData.map(d => d.y);
            const udpVals = udpData.map(d => d.y);
            const tcpMin = Math.min(...tcpVals);
            const tcpMax = Math.max(...tcpVals);
            const tcpAvg = Math.round(tcpVals.reduce((s, v) => s + v, 0) / tcpVals.length);
            const udpMax = Math.max(...udpVals);
            const udpAvg = Math.round(udpVals.reduce((s, v) => s + v, 0) / udpVals.length);
            connBadgeEl.textContent = `TCP Min/Max/Avg: ${tcpMin}/${tcpMax}/${tcpAvg} | UDP Max/Avg: ${udpMax}/${udpAvg}`;
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function formatBytes(bytes) {
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(Math.abs(bytes) || 1) / Math.log(k));
        const idx = Math.min(i, sizes.length - 1);
        return (bytes / Math.pow(k, idx)).toFixed(1) + " " + sizes[idx];
    }

    function formatBps(bitsPerSec) {
        if (bitsPerSec == null || isNaN(bitsPerSec)) return "0 bps";
        if (bitsPerSec < 1000) return bitsPerSec.toFixed(0) + " bps";
        if (bitsPerSec < 1_000_000) return (bitsPerSec / 1_000).toFixed(1) + " Kbps";
        if (bitsPerSec < 1_000_000_000) return (bitsPerSec / 1_000_000).toFixed(2) + " Mbps";
        return (bitsPerSec / 1_000_000_000).toFixed(2) + " Gbps";
    }

    function formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);

        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    // ─── Range Buttons ───────────────────────────────────────────────────────

    function setupRangeButtons() {
        const allRangeBtns = document.querySelectorAll(".range-btn[data-range]");
        const customBtn = document.getElementById("btnCustomRange");
        const popover = document.getElementById("customRangePopover");
        const customInput = document.getElementById("customRangeValue");
        const customUnit = document.getElementById("customRangeUnit");
        const applyBtn = document.getElementById("btnApplyCustomRange");

        // Helper: format seconds to human-readable label for custom button
        function formatCustomLabel(secs) {
            if (secs >= 86400) {
                const d = Math.round(secs / 86400);
                return d + "d";
            }
            const h = Math.round(secs / 3600);
            return h + "h";
        }

        // Helper: clear all active states and set custom
        function activateCustom(seconds) {
            customSeconds = seconds;
            currentRange = null;
            allRangeBtns.forEach(b => b.classList.remove("active"));
            customBtn.classList.add("active");
            customBtn.querySelector("svg").nextSibling.textContent = " " + formatCustomLabel(seconds);
            popover.classList.remove("show");
            fetchMetrics();
        }

        // Preset range buttons
        allRangeBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                customSeconds = null;
                allRangeBtns.forEach(b => b.classList.remove("active"));
                customBtn.classList.remove("active");
                // Reset custom button text
                const svgEl = customBtn.querySelector("svg");
                if (svgEl && svgEl.nextSibling) svgEl.nextSibling.textContent = " Custom";
                btn.classList.add("active");
                currentRange = btn.dataset.range;
                popover.classList.remove("show");
                fetchMetrics();
            });
        });

        // Toggle custom popover
        if (customBtn) {
            customBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                popover.classList.toggle("show");
            });
        }

        // Apply button
        if (applyBtn) {
            applyBtn.addEventListener("click", () => {
                const val = parseInt(customInput.value, 10);
                const unit = parseInt(customUnit.value, 10);
                if (val > 0) {
                    const secs = Math.min(val * unit, 7776000); // cap 90 days
                    activateCustom(secs);
                }
            });
        }

        // Enter key on input
        if (customInput) {
            customInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    applyBtn.click();
                }
            });
        }

        // Quick presets
        document.querySelectorAll(".custom-preset").forEach(btn => {
            btn.addEventListener("click", () => {
                const hours = parseInt(btn.dataset.hours, 10);
                activateCustom(hours * 3600);
            });
        });

        // Close popover on click outside
        document.addEventListener("click", (e) => {
            if (popover && !popover.contains(e.target) && e.target !== customBtn && !customBtn.contains(e.target)) {
                popover.classList.remove("show");
            }
        });

        // Smoothing level change — re-render charts with last data
        const smoothSelect = document.getElementById("smoothLevel");
        if (smoothSelect) {
            // Restore saved value
            const saved = localStorage.getItem("smoothLevel");
            if (saved !== null) smoothSelect.value = saved;

            smoothSelect.addEventListener("change", () => {
                localStorage.setItem("smoothLevel", smoothSelect.value);
                // Re-render with existing data
                if (window.lastMetricsJson && window.lastMetricsJson.data) {
                    updateCharts(window.lastMetricsJson.data);
                }
            });
        }
    }

    // ─── Fullscreen Buttons ──────────────────────────────────────────────────

    function setupFullscreenButtons() {
        const buttons = document.querySelectorAll(".btn-fullscreen");
        buttons.forEach(btn => {
            btn.addEventListener("click", () => {
                const card = btn.closest(".chart-card");
                if (!card) return;

                card.classList.toggle("fullscreen");

                const iconExpand = btn.querySelector(".icon-expand");
                const iconCompress = btn.querySelector(".icon-compress");

                if (card.classList.contains("fullscreen")) {
                    if (iconExpand) iconExpand.style.display = "none";
                    if (iconCompress) iconCompress.style.display = "block";
                    // Prevent body scroll when a chart is fullscreen
                    document.body.style.overflow = "hidden";
                } else {
                    if (iconExpand) iconExpand.style.display = "block";
                    if (iconCompress) iconCompress.style.display = "none";
                    // Restore body scroll (assuming no other fullscreen cards)
                    const otherFullscreen = document.querySelector(".chart-card.fullscreen");
                    if (!otherFullscreen) {
                        document.body.style.overflow = "";
                    }
                }

                // Give the browser a moment to apply CSS before triggering resize
                setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
            });
        });
    }

    // ─── Payload Dropdown Handler ────────────────────────────────────────────

    async function updatePayloadDisplay() {
        const val = document.getElementById("payloadRange").value;
        const displayEl = document.getElementById("livePayload");
        const nicVal = document.getElementById("nicSelect") ? document.getElementById("nicSelect").value : null;
        if (!displayEl) return;

        if (val === "boot") {
            if (window.lastBootTotals) {
                displayEl.innerHTML = `<span style="color:#059669">↑${window.lastBootTotals.sent_gb.toFixed(2)} GB</span> &nbsp; <span style="color:#0891b2">↓${window.lastBootTotals.recv_gb.toFixed(2)} GB</span>`;
            }
        } else {
            let dataArray = null;
            if (val === currentRange && window.lastMetricsJson && window.lastMetricsJson.data) {
                dataArray = window.lastMetricsJson.data;
            } else {
                try {
                    const res = await fetch(`/api/metrics?range=${val}`);
                    const json = await res.json();
                    dataArray = json.data;
                } catch (err) { return; }
            }

            if (dataArray && dataArray.length > 0) {
                let sentSum = 0;  // accumulates bytes
                let recvSum = 0;
                let interval = 30; // default to 30s
                if (dataArray.length > 1) {
                    interval = dataArray[1].t - dataArray[0].t;
                }
                
                for (let i = 0; i < dataArray.length; i++) {
                    const d = dataArray[i];
                    if (d.extra && d.extra.nic_rates && d.extra.nic_rates[nicVal]) {
                        // sent_bps is BITS/sec — divide by 8 to get bytes/sec, then multiply by interval
                        sentSum += (d.extra.nic_rates[nicVal].sent_bps || 0) / 8;
                        recvSum += (d.extra.nic_rates[nicVal].recv_bps || 0) / 8;
                    } else if (nicVal === 'ens3' || nicVal === 'eth0' || !nicVal || nicVal === 'all') {
                        // historical missing data for primary NIC or total — use top-level net_sent / net_recv (bytes/sec)
                        sentSum += d.net_sent || 0;
                        recvSum += d.net_recv || 0;
                    } else {
                        // historical missing data for secondary NIC — add 0
                        sentSum += 0;
                        recvSum += 0;
                    }
                }
                const sentGb = (sentSum * interval) / (1024 ** 3);
                const recvGb = (recvSum * interval) / (1024 ** 3);
                displayEl.innerHTML = `<span style="color:#059669">↑${sentGb.toFixed(2)} GB</span> &nbsp; <span style="color:#0891b2">↓${recvGb.toFixed(2)} GB</span>`;
            }
        }
    }

    function setupPayloadDropdown() {
        const payloadSel = document.getElementById("payloadRange");
        if (payloadSel) {
            payloadSel.addEventListener("change", updatePayloadDisplay);
        }
        const nicSel = document.getElementById("nicSelect");
        if (nicSel) {
            nicSel.addEventListener("change", () => {
                // Wait briefly for boot totals to update from main loop or manually call it
                setTimeout(updatePayloadDisplay, 100);
            });
        }
    }

    // ─── Daily Network Payload Handlers ──────────────────────────────────────
    let lastDailyPayloadData = null;

    async function fetchDailyPayload() {
        const daysSel = document.getElementById("payloadChartDaysSelect");
        const days = daysSel ? daysSel.value : 30;
        try {
            const res = await fetch(`/api/payload/daily?days=${days}`);
            if (!res.ok) return;
            const json = await res.json();
            if (json.status === "success") {
                lastDailyPayloadData = json;
                updateDailyPayloadChart();
            }
        } catch (err) {
            console.error("Failed to fetch daily payload:", err);
        }
    }

    function updateDailyPayloadChart() {
        if (!payloadDailyChart || !lastDailyPayloadData) return;
        const ifaceSel = document.getElementById("payloadChartIfaceSelect");
        if (!ifaceSel) return;

        // Populate interface select if needed
        const availableIfaces = (lastDailyPayloadData.interfaces || []).filter(i => 
            !['wg-nord-de', 'wg-nord-de1', 'wg-nord-ae', 'de', 'de1', 'ae', 'lo', 'docker0', 'wg0'].includes(i) && !i.startsWith('veth') && !i.startsWith('docker')
        );
        const currentIface = ifaceSel.value;
        const oldOpts = Array.from(ifaceSel.options).map(o => o.value);
        if (availableIfaces.length > 0 && (oldOpts.join(",") !== availableIfaces.join(",") || !availableIfaces.includes(currentIface))) {
            ifaceSel.innerHTML = '';
            availableIfaces.forEach(iface => {
                const opt = document.createElement("option");
                opt.value = iface;
                opt.textContent = iface;
                ifaceSel.appendChild(opt);
            });
            const defaultIface = (currentIface && availableIfaces.includes(currentIface)) ? currentIface :
                                 (window.detectedDefaultNic && availableIfaces.includes(window.detectedDefaultNic)) ? window.detectedDefaultNic :
                                 availableIfaces.includes('ens3') ? 'ens3' :
                                 availableIfaces[0] || 'ens3';
            ifaceSel.value = defaultIface;
        }

        const selectedIface = ifaceSel.value || (window.detectedDefaultNic || 'ens3');
        const list = (lastDailyPayloadData.data && lastDailyPayloadData.data[selectedIface]) ? lastDailyPayloadData.data[selectedIface] : [];

        const upPoints = list.map(d => ({ x: d.t * 1000, y: Math.max(0, parseFloat(d.upload_gb) || 0) }));
        const downPoints = list.map(d => ({ x: d.t * 1000, y: Math.max(0, parseFloat(d.download_gb) || 0) }));

        payloadDailyChart.data.datasets[0].data = downPoints;
        payloadDailyChart.data.datasets[1].data = upPoints;
        payloadDailyChart.update("none");

        // Calculate summary
        const totalUp = list.reduce((acc, d) => acc + (d.upload_gb || 0), 0);
        const totalDown = list.reduce((acc, d) => acc + (d.download_gb || 0), 0);
        const totalAll = totalUp + totalDown;

        const formatGb = (gb) => {
            if (gb >= 1024 * 1024) return (gb / (1024 * 1024)).toFixed(2) + " PB";
            if (gb >= 1024) return (gb / 1024).toFixed(2) + " TB";
            return gb.toFixed(2) + " GB";
        };

        const upEl = document.getElementById("payloadSummaryUp");
        const downEl = document.getElementById("payloadSummaryDown");
        const totalEl = document.getElementById("payloadSummaryTotal");
        if (upEl) upEl.textContent = `Up: ${formatGb(totalUp)}`;
        if (downEl) downEl.textContent = `Down: ${formatGb(totalDown)}`;
        if (totalEl) totalEl.textContent = `Total: ${formatGb(totalAll)}`;
    }

    // ─── Auto-Refresh ────────────────────────────────────────────────────────

    let topProcessesTimer = null;
    let topProcInterval = 5000;

    async function fetchTopProcesses() {
        try {
            const res = await fetch("/api/top_processes");
            const data = await res.json();

            const tbody = document.getElementById("topProcessesBody");
            if (!tbody) return;

            if (data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No processes found</td></tr>`;
                return;
            }

            // Build HTML
            const rowsHtml = data.map(p => {
                let cpuClass = "proc-cpu-low";
                if (p.cpu > 50) cpuClass = "proc-cpu-high";
                else if (p.cpu > 15) cpuClass = "proc-cpu-med";

                return `
                <tr>
                    <td class="proc-pid">#${p.pid}</td>
                    <td class="proc-name">${p.name}</td>
                    <td class="proc-user">${p.user}</td>
                    <td style="text-align: right;" class="proc-val">${p.mem}</td>
                    <td style="text-align: right;" class="proc-val ${cpuClass}">${p.cpu.toFixed(1)}%</td>
                </tr>
               `;
            }).join('');

            tbody.innerHTML = rowsHtml;
        } catch (err) {
            console.error("Failed to fetch top processes:", err);
        }
    }

    function setupTopProcInterval() {
        const select = document.getElementById("topProcRefresh");
        if (select) {
            select.addEventListener("change", (e) => {
                topProcInterval = parseInt(e.target.value, 10) || 1000;
                if (topProcessesTimer) {
                    clearInterval(topProcessesTimer);
                    fetchTopProcesses(); // fetch immediately
                    topProcessesTimer = setInterval(fetchTopProcesses, topProcInterval);
                }
            });
        }
    }

    function setupGlobalRefreshInterval() {
        const select = document.getElementById("globalRefreshSelect");
        if (select) {
            select.value = (STATS_INTERVAL / 1000).toString();
            
            // Sync with backend on startup
            fetch(`/api/settings/interval?seconds=${select.value}`, { method: 'POST' }).catch(e => console.error(e));

            select.addEventListener("change", (e) => {
                const val = parseInt(e.target.value, 10);
                if (val) {
                    localStorage.setItem('uiRefreshInterval', val);
                    STATS_INTERVAL = val * 1000;
                    
                    fetch(`/api/settings/interval?seconds=${val}`, { method: 'POST' }).catch(e => console.error(e));

                    if (statsTimer) {
                        clearInterval(statsTimer);
                        fetchCurrent();
                        statsTimer = setInterval(fetchCurrent, STATS_INTERVAL);
                    }
                    
                    window.dispatchEvent(new CustomEvent('globalRefreshChanged', { detail: STATS_INTERVAL }));
                }
            });
        }
    }

    function startAutoRefresh() {
        setupGlobalRefreshInterval();
        // Live stats every X seconds
        statsTimer = setInterval(fetchCurrent, STATS_INTERVAL);
        // Charts every 30 seconds
        chartTimer = setInterval(fetchMetrics, CHART_INTERVAL);

        // Top processes
        setupTopProcInterval();
        fetchTopProcesses();
        topProcessesTimer = setInterval(fetchTopProcesses, topProcInterval);

        // Daily payload refresh every 60s
        fetchDailyPayload();
        setInterval(fetchDailyPayload, 60000);
    }

    // ─── Initialize ──────────────────────────────────────────────────────────

    // ─── Dark Mode Toggle ────────────────────────────────────────────────────

    function isDarkMode() {
        const t = document.documentElement.getAttribute("data-theme") || "dark";
        const lightThemes = ["light", "catppuccin-latte", "solarized-light"];
        return !lightThemes.includes(t);
    }

    function updateChartColors() {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        const lightThemes = ["light", "catppuccin-latte", "solarized-light"];
        
        const gridColor = getGridColor();
        const tickColor = lightThemes.includes(theme) ? "#64748b" : (theme === "dark" ? "#787f8d" : (theme === "cyberpunk" ? "#00f3ff" : (theme === "oled" ? "#cbd5e1" : "#94a3b8")));

        // Update all existing chart instances
        Chart.helpers.each(Chart.instances, (chart) => {
            if (!chart.options.scales) return;
            Object.values(chart.options.scales).forEach(scale => {
                if (scale.grid) scale.grid.color = gridColor;
                if (scale.ticks) scale.ticks.color = tickColor;
            });
            chart.update("none");
        });
    }

    function setupThemeToggle() {
        const btn = document.getElementById("themeDropdownBtn");
        const menu = document.getElementById("themeMenu");
        const nameDisplay = document.getElementById("currentThemeName");
        if (!btn || !menu || !nameDisplay) return;

        let currentTheme = localStorage.getItem("sm-theme") || "dark";
        document.documentElement.setAttribute("data-theme", currentTheme);

        const options = menu.querySelectorAll(".theme-option");

        function updateDisplay(themeVal) {
            options.forEach(opt => {
                if (opt.getAttribute("data-value") === themeVal) {
                    nameDisplay.innerHTML = opt.innerHTML;
                    opt.classList.add("selected");
                } else {
                    opt.classList.remove("selected");
                }
            });
        }

        updateDisplay(currentTheme);

        // Toggle menu
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const expanded = btn.getAttribute("aria-expanded") === "true";
            btn.setAttribute("aria-expanded", !expanded);
            btn.classList.toggle("active");
            menu.classList.toggle("show");
        });

        // Close when clicking outside
        document.addEventListener("click", (e) => {
            if (!menu.contains(e.target) && !btn.contains(e.target)) {
                btn.setAttribute("aria-expanded", "false");
                btn.classList.remove("active");
                menu.classList.remove("show");
            }
        });

        // Handle selection (apply ONLY on click)
        options.forEach(opt => {
            opt.addEventListener("click", (e) => {
                e.stopPropagation();
                const selectedVal = opt.getAttribute("data-value");
                currentTheme = selectedVal;

                document.documentElement.setAttribute("data-theme", currentTheme);
                updateDisplay(currentTheme);
                localStorage.setItem("sm-theme", currentTheme);
                updateChartColors();

                btn.setAttribute("aria-expanded", "false");
                btn.classList.remove("active");
                menu.classList.remove("show");
            });
        });
    }

    // ─── Per-Core CPU Cylinder Rendering ──────────────────────────────────────

    function renderCpuCores(perCoreArray) {
        const grid = document.getElementById("cpuCoresGrid");
        if (!grid) return;

        const TOTAL_LINES = 50;

        // Build or update DOM
        if (grid.children.length !== perCoreArray.length) {
            // Rebuild
            grid.innerHTML = '';
            perCoreArray.forEach((_, idx) => {
                const item = document.createElement('div');
                item.className = 'cpu-core-item';

                const label = document.createElement('div');
                label.className = 'cpu-core-label';
                label.textContent = `C${idx}`;

                const cylinder = document.createElement('div');
                cylinder.className = 'cpu-cylinder';
                cylinder.id = `cpuCyl${idx}`;

                // Create 50 lines (bottom-up: index 0 = bottom, 49 = top)
                for (let i = 0; i < TOTAL_LINES; i++) {
                    const line = document.createElement('div');
                    line.className = 'cpu-cylinder-line empty';
                    cylinder.appendChild(line);
                    // Add tiny spacer between lines
                    if (i < TOTAL_LINES - 1) {
                        const sp = document.createElement('div');
                        sp.className = 'cpu-cylinder-line spacer';
                        cylinder.appendChild(sp);
                    }
                }

                const pct = document.createElement('div');
                pct.className = 'cpu-core-percent';
                pct.id = `cpuCorePct${idx}`;
                pct.textContent = '0%';

                item.appendChild(label);
                item.appendChild(cylinder);
                item.appendChild(pct);
                grid.appendChild(item);
            });
        }

        // Update values
        perCoreArray.forEach((percent, idx) => {
            const cylinder = document.getElementById(`cpuCyl${idx}`);
            const pctEl = document.getElementById(`cpuCorePct${idx}`);
            if (!cylinder || !pctEl) return;

            pctEl.textContent = Math.round(percent) + '%';

            const filledCount = Math.round(percent / 2); // 50 lines, each = 2%
            const lines = cylinder.querySelectorAll('.cpu-cylinder-line:not(.spacer)');

            lines.forEach((line, lineIdx) => {
                if (lineIdx < filledCount) {
                    // Determine color based on line position (lineIdx is 0=bottom)
                    const linePercent = (lineIdx + 1) * 2;
                    let colorClass;
                    if (linePercent <= 60) {
                        colorClass = 'line-green';
                    } else if (linePercent <= 80) {
                        colorClass = 'line-yellow';
                    } else {
                        colorClass = 'line-red';
                    }
                    line.className = `cpu-cylinder-line filled ${colorClass}`;
                } else {
                    line.className = 'cpu-cylinder-line empty';
                }
            });
        });
    }

    // ─── NIC Selection ───────────────────────────────────────────────────────

    async function fetchInterfaces() {
        try {
            const res = await fetch('/api/interfaces');
            const json = await res.json();

            const nicSelect = document.getElementById('nicSelect');
            const connSelect = document.getElementById('connIfaceSelect');
            const netChartIfaceSel = document.getElementById('netChartIfaceSelect');
            if (!nicSelect) return;

            nicSelect.innerHTML = '';
            // Add discovered interfaces to both dropdowns
            const ifaces = json.interfaces || [];
            const defaultNic = json.default || '';

            window.discoveredInterfaces = ifaces.map(i => i.name);
            window.detectedDefaultNic = defaultNic;

            ifaces.forEach(iface => {
                const opt = document.createElement('option');
                opt.value = iface.name;
                opt.textContent = iface.name;
                if (iface.name === defaultNic) opt.selected = true;
                nicSelect.appendChild(opt);
            });

            // Set netChartIfaceSel dropdown
            if (netChartIfaceSel && ifaces.length > 0) {
                const currentVal = netChartIfaceSel.value;
                netChartIfaceSel.innerHTML = '';
                ifaces.forEach(iface => {
                    const opt = document.createElement('option');
                    opt.value = iface.name;
                    opt.textContent = iface.name;
                    if (iface.name === (currentVal || defaultNic)) opt.selected = true;
                    netChartIfaceSel.appendChild(opt);
                });
                netChartIfaceSel.value = (currentVal && ifaces.some(i => i.name === currentVal)) ? currentVal : (defaultNic || ifaces[0].name);
            }

            // Set connSelect default to the detected NIC
            if (connSelect) {
                // Clear existing and rebuild
                const currentVal = connSelect.value;
                connSelect.innerHTML = '';
                ifaces.forEach(iface => {
                    const opt = document.createElement('option');
                    opt.value = iface.name;
                    opt.textContent = iface.name;
                    if (iface.name === defaultNic) opt.selected = true;
                    connSelect.appendChild(opt);
                });
                // Add Total option
                const totalOpt = document.createElement('option');
                totalOpt.value = 'Total';
                totalOpt.textContent = 'Total';
                connSelect.appendChild(totalOpt);
            }

            selectedNic = defaultNic;

            // Listen for NIC change
            nicSelect.addEventListener('change', () => {
                selectedNic = nicSelect.value;
            });
        } catch (err) {
            console.error('Failed to fetch interfaces:', err);
        }
    }

    // ─── CPU Benchmark ───────────────────────────────────────────────────────
    // ─── CPU/System Benchmark ───────────────────────────────────────────────────
    function setupBenchmark() {
        const btn = document.getElementById("btnBenchmarkCpu");
        const btnStopMain = document.getElementById("btnStopBenchmark"); // main page stop
        const btnStopModal = document.getElementById("btnStopBenchmarkModal"); // modal stop
        
        const overlay = document.getElementById("benchmarkOverlay");
        const closeBtn = document.getElementById("closeBenchmark");
        
        const runningState = document.getElementById("benchmarkRunningState");
        const resultState = document.getElementById("benchmarkResultState");
        
        const progressBar = document.getElementById("benchmarkProgressBar");
        const progressPercent = document.getElementById("benchmarkProgressPercent");
        const progressText = document.getElementById("benchmarkProgressText");
        
        // Modal Results
        const modalOverallScore = document.getElementById("modalOverallScore");
        const scoreCpuSingle = document.getElementById("scoreCpuSingle");
        const metaCpuSingle = document.getElementById("metaCpuSingle");
        const scoreCpuMulti = document.getElementById("scoreCpuMulti");
        const metaCpuMulti = document.getElementById("metaCpuMulti");
        const scoreRam = document.getElementById("scoreRam");
        const metaRam = document.getElementById("metaRam");
        const scoreDisk = document.getElementById("scoreDisk");
        const metaDisk = document.getElementById("metaDisk");
        
        // Also main page results
        const mainResultDiv = document.getElementById("benchmarkResult");
        const mainScoreSpan = document.getElementById("benchmarkScore");

        if (!btn || !overlay || !closeBtn || !runningState || !resultState || !progressBar || !progressPercent || !progressText) return;

        let progressInterval = null;
        let activeProgress = 0;
        let isRunning = false;

        // Helper: Reset and open modal
        function openModal() {
            overlay.classList.remove("hidden");
            document.body.style.overflow = "hidden"; // disable scroll
            
            // Show running state, hide results
            runningState.classList.remove("hidden");
            resultState.classList.add("hidden");
            
            progressBar.style.width = "0%";
            progressPercent.textContent = "0%";
            progressText.textContent = "Initializing benchmark...";
            activeProgress = 0;
        }

        // Helper: Close modal
        function closeModal() {
            if (isRunning) return; // don't close while running unless stopped
            overlay.classList.add("hidden");
            document.body.style.overflow = ""; // restore scroll
        }

        closeBtn.addEventListener("click", closeModal);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeModal();
        });

        // Helper: Smoothly animate overall score counter
        function animateScore(element, endVal) {
            let current = 0;
            if (endVal <= 0) {
                element.textContent = "0";
                return;
            }
            const duration = 1200; // 1.2s total duration
            const startTime = performance.now();

            function update(now) {
                const elapsed = now - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // Ease out cubic
                const easeProgress = 1 - Math.pow(1 - progress, 3);
                current = Math.floor(easeProgress * endVal);
                element.textContent = current.toLocaleString();

                if (progress < 1) {
                    requestAnimationFrame(update);
                } else {
                    element.textContent = endVal.toLocaleString();
                }
            }
            requestAnimationFrame(update);
        }

        // Helper: Stop benchmark
        async function stopBenchmark() {
            try {
                if (btnStopMain) {
                    btnStopMain.disabled = true;
                    btnStopMain.querySelector('.btn-text').textContent = "Stopping...";
                }
                if (btnStopModal) {
                    btnStopModal.disabled = true;
                    btnStopModal.querySelector('.btn-text').textContent = "Stopping...";
                }
                
                await fetch("/api/benchmark/cpu/stop");
                
                // Clear interval
                if (progressInterval) clearInterval(progressInterval);
                progressText.textContent = "Benchmark stopped by user.";
                
                isRunning = false;
                setTimeout(() => {
                    overlay.classList.add("hidden");
                    document.body.style.overflow = "";
                    
                    // Reset buttons
                    if (btnStopMain) {
                        btnStopMain.disabled = false;
                        btnStopMain.querySelector('.btn-text').textContent = "Stop";
                        btnStopMain.classList.add("hidden");
                    }
                    if (btnStopModal) {
                        btnStopModal.disabled = false;
                        btnStopModal.querySelector('.btn-text').textContent = "Stop Benchmark";
                    }
                    btn.disabled = false;
                    btn.querySelector('.btn-text').textContent = "Run Benchmark";
                }, 1000);
            } catch (err) {
                console.error("Failed to stop benchmark:", err);
            }
        }

        btn.addEventListener("click", async () => {
            if (isRunning) return;
            isRunning = true;
            openModal();

            // Set main layout button state
            btn.disabled = true;
            btn.querySelector('.btn-text').textContent = "Running...";
            if (btnStopMain) btnStopMain.classList.remove("hidden");

            // Start smooth progress loading bar
            // Total benchmark takes ~6.5 seconds.
            // 6500ms / 100 steps = 65ms per 1% increment.
            progressInterval = setInterval(() => {
                if (activeProgress < 99) {
                    activeProgress += 1;
                    progressBar.style.width = activeProgress + "%";
                    progressPercent.textContent = activeProgress + "%";

                    // Dynamic stages messages based on progress
                    if (activeProgress < 30) {
                        progressText.textContent = `Running Single-Core CPU test... (${activeProgress}%)`;
                    } else if (activeProgress < 60) {
                        progressText.textContent = `Running Multi-Core CPU test... (${activeProgress}%)`;
                    } else if (activeProgress < 80) {
                        progressText.textContent = `Measuring Memory (RAM) speed... (${activeProgress}%)`;
                    } else {
                        progressText.textContent = `Measuring Disk Read/Write speed... (${activeProgress}%)`;
                    }
                }
            }, 65);

            try {
                const res = await fetch("/api/benchmark/cpu");
                const data = await res.json();

                if (progressInterval) clearInterval(progressInterval);

                if (data.error) {
                    progressText.textContent = data.error;
                    if (mainScoreSpan) mainScoreSpan.textContent = "Error";
                    isRunning = false;
                } else if (data.status === "stopped") {
                    progressText.textContent = "Benchmark stopped.";
                    if (mainScoreSpan) mainScoreSpan.textContent = "Stopped";
                    isRunning = false;
                } else {
                    // Set progress to 100%
                    progressBar.style.width = "100%";
                    progressPercent.textContent = "100%";
                    progressText.textContent = "Benchmark complete! Loading results...";

                    setTimeout(() => {
                        // Switch modal views
                        runningState.classList.add("hidden");
                        resultState.classList.remove("hidden");
                        
                        // Populate sub-scores and stats in overlay
                        scoreCpuSingle.textContent = `${data.cpu_single_score} pts`;
                        metaCpuSingle.textContent = `${data.cpu_single_val.toLocaleString()} real-world tasks/sec`;
                        
                        scoreCpuMulti.textContent = `${data.cpu_multi_score} pts`;
                        const labelCpuMulti = document.getElementById("labelCpuMulti");
                        if (data.cores === 1) {
                            if (labelCpuMulti) labelCpuMulti.textContent = "CPU Stress Test";
                            metaCpuMulti.textContent = `${data.cpu_multi_val.toLocaleString()} tasks/sec (Sustained)`;
                        } else {
                            if (labelCpuMulti) labelCpuMulti.textContent = "CPU Multi-Core";
                            const scaling = (data.cpu_single_val > 0) ? (data.cpu_multi_val / data.cpu_single_val).toFixed(1) : "0";
                            metaCpuMulti.textContent = `${data.cpu_multi_val.toLocaleString()} tasks/sec (${scaling}x speedup)`;
                        }
                        
                        scoreRam.textContent = `${data.ram_score} pts`;
                        metaRam.textContent = `${data.ram_val_gbps} GB/s Read-Write`;
                        
                        scoreDisk.textContent = `${data.disk_score} pts`;
                        metaDisk.textContent = `Write: ${data.disk_write_mbps} MB/s | Read: ${data.disk_read_mbps} MB/s`;

                        // Animate overall score circular counter
                        animateScore(modalOverallScore, data.score);

                        // Also update the main dashboard card score
                        if (mainScoreSpan) mainScoreSpan.textContent = data.score.toLocaleString();
                        if (mainResultDiv) mainResultDiv.classList.remove("hidden");

                        isRunning = false;
                    }, 500);
                }
            } catch (err) {
                console.error(err);
                if (progressInterval) clearInterval(progressInterval);
                progressText.textContent = "An error occurred during testing.";
                if (mainScoreSpan) mainScoreSpan.textContent = "Error";
                isRunning = false;
            } finally {
                // Restore main dashboard buttons
                btn.disabled = false;
                btn.querySelector('.btn-text').textContent = "Run Benchmark";
                if (btnStopMain) btnStopMain.classList.add("hidden");
            }
        });

        // Click listeners for stop
        if (btnStopMain) {
            btnStopMain.addEventListener("click", stopBenchmark);
        }
        if (btnStopModal) {
            btnStopModal.addEventListener("click", stopBenchmark);
        }
    }

    function setupSettings() {
        const btnOpen = document.getElementById('btnSettingsOpen');
        if (!btnOpen) return; // Wait for correct ID if missing

        const overlay = document.getElementById('settingsOverlay');
        const btnClose = document.getElementById('closeSettings');

        // Open/Close logic
        btnOpen.addEventListener('click', () => {
            overlay.classList.remove('hidden');
        });

        btnClose.addEventListener('click', () => {
            overlay.classList.add('hidden');
        });

        // Close on outside click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });

        // 1. SSL Form Handling
        const sslForm = document.getElementById('sslForm');
        sslForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btnSaveSSL');
            const loader = btn.querySelector('.btn-loader');
            const status = document.getElementById('sslStatus');
            const keyContent = document.getElementById('sslKey').value;
            const certContent = document.getElementById('sslCert').value;

            btn.disabled = true;
            loader.classList.remove('hidden');
            status.textContent = "Saving and scheduling restart...";
            status.style.color = "var(--text-primary)";

            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        certificate_pem: certContent,
                        private_key_pem: keyContent
                    })
                });

                if (res.ok) {
                    status.textContent = "Saved successfully! Panel is restarting in 2 seconds...";
                    status.style.color = "#10b981";
                    setTimeout(() => {
                        window.location.reload();
                    }, 4000);
                } else {
                    const data = await res.json();
                    throw new Error(data.detail || "Server error");
                }
            } catch (err) {
                status.textContent = "Error: " + err.message;
                status.style.color = "#ef4444";
                btn.disabled = false;
                loader.classList.add('hidden');
            }
        });

        // 2. DB Backup Download
        document.getElementById('btnBackupDb').addEventListener('click', () => {
            window.location.href = "/api/backup";
        });

        // 3. DB Restore Upload
        const fileInput = document.getElementById('dbFileInput');
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const btn = document.getElementById('btnRestoreDb');
            const loader = btn.querySelector('.btn-loader');
            const span = btn.querySelector('.btn-text');

            if (!confirm(`Warning: This will completely replace your current metrics history. The panel will restart immediately.\n\nAre you sure you want to restore ${file.name}?`)) {
                fileInput.value = "";
                return;
            }

            btn.disabled = true;
            loader.classList.remove('hidden');
            span.textContent = "Uploading...";

            const formData = new FormData();
            formData.append("file", file);

            try {
                const res = await fetch("/api/restore", {
                    method: "POST",
                    body: formData
                });

                if (res.ok) {
                    span.textContent = "Restarting Server...";
                    setTimeout(() => {
                        window.location.reload();
                    }, 3000);
                } else {
                    const data = await res.json();
                    throw new Error(data.detail || "Failed to restore");
                }
            } catch (err) {
                alert("Restore failed: " + err.message);
                btn.disabled = false;
                loader.classList.add('hidden');
                span.textContent = "Restore & Restart";
                fileInput.value = "";
            }
        });
    }

    function setupV2rayMonitor() {
        const btnOpen = document.getElementById('btnV2rayOpen');
        const overlay = document.getElementById('v2rayOverlay');
        const btnClose = document.getElementById('closeV2ray');
        const searchInput = document.getElementById('v2raySearch');
        const tableBody = document.getElementById('v2rayTableBody');
        const activeCountSpan = document.getElementById('v2rayActiveCount');
        const totalCountSpan = document.getElementById('v2rayTotalCount');

        if (!btnOpen || !overlay) return;

        let pollInterval = null;
        let countdownInterval = null;
        let lastUpdateSec = 0;
        let cachedUsers = [];

        // Open
        btnOpen.addEventListener('click', () => {
            overlay.classList.remove('hidden');
            fetchV2rayUsers();
            // Start polling every 60000ms
            if (!pollInterval) {
                pollInterval = setInterval(fetchV2rayUsers, 60000);
            }
            if (!countdownInterval) {
                countdownInterval = setInterval(tickCountdown, 1000);
            }
        });

        // Close
        function closeOverlay() {
            overlay.classList.add('hidden');
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            lastUpdateSec = 0;
            const timerSpan = document.getElementById('v2rayTimer');
            if (timerSpan) {
                timerSpan.textContent = '60s';
                timerSpan.style.color = '#6366f1';
            }
        }

        btnClose.addEventListener('click', closeOverlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeOverlay();
            }
        });

        // Search Filter
        searchInput.addEventListener('input', () => {
            renderTable();
        });

        function updateSyncTimer(backendLastUpdate) {
            if (backendLastUpdate > lastUpdateSec) {
                const timerBadge = document.getElementById('v2rayTimerContainer');
                if (timerBadge && lastUpdateSec > 0) { // Don't flash on first load
                    timerBadge.style.transition = 'none';
                    timerBadge.style.borderColor = '#10b981';
                    timerBadge.style.background = 'rgba(16, 185, 129, 0.1)';
                    setTimeout(() => {
                        timerBadge.style.transition = 'border-color 0.5s ease, background 0.5s ease';
                        timerBadge.style.borderColor = 'var(--border-color)';
                        timerBadge.style.background = 'var(--bg-card)';
                    }, 800);
                }
            }
            lastUpdateSec = backendLastUpdate;
            tickCountdown();
        }

        function tickCountdown() {
            if (!lastUpdateSec) return;
            const nowSec = Date.now() / 1000;
            const elapsed = Math.floor(nowSec - lastUpdateSec);
            const remaining = Math.max(0, 60 - elapsed);
            
            const timerSpan = document.getElementById('v2rayTimer');
            if (timerSpan) {
                if (remaining === 0) {
                    timerSpan.textContent = 'Syncing...';
                    timerSpan.style.color = '#ef4444';
                } else {
                    timerSpan.textContent = remaining + 's';
                    timerSpan.style.color = '#6366f1';
                }
            }
        }

        async function fetchV2rayUsers() {
            try {
                const res = await fetch("/api/v2ray/users");
                if (res.ok) {
                    const data = await res.json();
                    if (data.error) {
                        tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #ef4444; padding: 20px;">${data.error}</td></tr>`;
                        return;
                    }
                    cachedUsers = data.users || [];
                    const backendLastUpdate = data.last_update || 0;
                    updateSyncTimer(backendLastUpdate);
                    renderTable();
                } else {
                    console.error("Failed to fetch V2ray users: " + res.statusText);
                }
            } catch (err) {
                console.error("Error fetching V2ray users:", err);
            }
        }

        function formatSpeed(mbps) {
            if (mbps >= 1.0) {
                return `${mbps.toFixed(2)} Mbps`;
            } else {
                return `${(mbps * 1024).toFixed(0)} Kbps`;
            }
        }

        function formatTraffic(gb) {
            if (gb >= 1.0) {
                return `${gb.toFixed(2)} GB`;
            } else {
                return `${(gb * 1024).toFixed(1)} MB`;
            }
        }

        function formatLastActive(lastOnline, isOnline) {
            if (isOnline) return '<span style="color: #10b981; font-weight: bold;">Online</span>';
            if (!lastOnline) return '<span style="color: var(--text-secondary);">Never</span>';
            const date = new Date(lastOnline);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `${diffMins}m ago`;
            const diffHours = Math.floor(diffMins / 60);
            if (diffHours < 24) return `${diffHours}h ago`;
            return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        function renderTable() {
            const query = searchInput.value.toLowerCase().trim();
            
            // Filter users
            const filtered = cachedUsers.filter(u => {
                return u.email && u.email.toLowerCase().includes(query);
            });

            // Sort by download speed descending, then upload speed
            filtered.sort((a, b) => b.down_speed_mbps - a.down_speed_mbps || b.up_speed_mbps - a.up_speed_mbps);

            // Update stats
            const onlineCount = cachedUsers.filter(u => u.is_online).length;
            activeCountSpan.textContent = onlineCount;
            totalCountSpan.textContent = cachedUsers.length;

            if (filtered.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-secondary); padding: 30px;">No users found</td></tr>`;
                return;
            }

            tableBody.innerHTML = filtered.map(u => {
                const isOnline = u.is_online;
                const statusDot = isOnline 
                    ? '<span class="pulse-dot" style="display: inline-block; margin-right: 8px; vertical-align: middle;"></span>' 
                    : '<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 8px; vertical-align: middle;"></span>';
                
                const speedDownText = isOnline ? formatSpeed(u.down_speed_mbps) : formatSpeed(0);
                const speedUpText = isOnline ? formatSpeed(u.up_speed_mbps) : formatSpeed(0);
                
                // Highlight active speeds
                const speedDownStyle = (isOnline && u.down_speed_mbps > 0.05) ? 'color: #10b981; font-weight: bold;' : '';
                const speedUpStyle = (isOnline && u.up_speed_mbps > 0.05) ? 'color: #3b82f6; font-weight: bold;' : '';

                // Limit display: if total_limit_gb is 0.0, it means unlimited
                const limitText = u.total_limit_gb > 0 ? ` / ${u.total_limit_gb} GB` : '';
                const totalDownText = formatTraffic(u.total_down_gb);
                const totalUpText = formatTraffic(u.total_up_gb);

                return `
                    <tr style="${!u.enable ? 'opacity: 0.5;' : ''}">
                        <td style="display: flex; align-items: center; font-weight: 500;">
                            ${statusDot}
                            <span>${u.email}</span>
                            ${!u.enable ? ' <span style="font-size: 0.75rem; color: #ef4444; background: rgba(239, 68, 68, 0.1); padding: 2px 6px; border-radius: 4px; margin-left: 8px;">Disabled</span>' : ''}
                        </td>
                        <td style="text-align: right; ${speedDownStyle}">${speedDownText}</td>
                        <td style="text-align: right; ${speedUpStyle}">${speedUpText}</td>
                        <td style="text-align: right;">${totalDownText}${limitText}</td>
                        <td style="text-align: right;">${totalUpText}</td>
                        <td style="text-align: center; font-weight: ${u.unique_ips > 1 ? 'bold' : 'normal'}; color: ${u.unique_ips > 2 ? '#f59e0b' : 'inherit'};">${u.unique_ips || 0}</td>
                        <td style="text-align: center; font-size: 0.85rem;">${formatLastActive(u.last_online, isOnline)}</td>
                    </tr>
                `;
            }).join('');
        }
    }

    function setupTelegramAlerts() {
        const btnOpen = document.getElementById('btnTelegramOpen');
        const overlay = document.getElementById('telegramOverlay');
        const btnClose = document.getElementById('closeTelegram');
        
        const tgBotToken = document.getElementById('tgBotToken');
        const tgChatId = document.getElementById('tgChatId');
        const tgInterval = document.getElementById('tgInterval');
        const tgCustomIntervalContainer = document.getElementById('tgCustomIntervalContainer');
        const tgCustomInterval = document.getElementById('tgCustomInterval');
        const tgGraphHours = document.getElementById('tgGraphHours');
        const tgCpuTh = document.getElementById('tgCpuTh');
        const tgRamTh = document.getElementById('tgRamTh');
        const tgLoadTh = document.getElementById('tgLoadTh');
        const tgLoadAvgType = document.getElementById('tgLoadAvgType');
        const tgDiskTh = document.getElementById('tgDiskTh');
        const tgSendCpuGraph = document.getElementById('tgSendCpuGraph');
        const tgSendRamGraph = document.getElementById('tgSendRamGraph');
        const tgSendLoad1mGraph = document.getElementById('tgSendLoad1mGraph');
        const tgSendLoad5mGraph = document.getElementById('tgSendLoad5mGraph');
        const tgSendLoad15mGraph = document.getElementById('tgSendLoad15mGraph');
        const tgSendNetGraph = document.getElementById('tgSendNetGraph');
        const tgAlertSendGraph = document.getElementById('tgAlertSendGraph');
        const tgEnabled = document.getElementById('tgEnabled');
        
        const btnSave = document.getElementById('btnTelegramSave');
        const btnTest = document.getElementById('btnTelegramTest');

        if (!btnOpen || !overlay) return;

        function toggleCustomInterval() {
            if (tgInterval.value.toString() === "-1") {
                tgCustomIntervalContainer.style.setProperty('display', 'flex', 'important');
            } else {
                tgCustomIntervalContainer.style.setProperty('display', 'none', 'important');
            }
        }
        tgInterval.addEventListener('change', toggleCustomInterval);

        // Open
        btnOpen.addEventListener('click', async () => {
            overlay.classList.remove('hidden');
            await loadTelegramConfig();
        });

        // Close
        function closeOverlay() {
            overlay.classList.add('hidden');
        }
        btnClose.addEventListener('click', closeOverlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOverlay();
        });

        async function loadTelegramConfig() {
            try {
                const res = await fetch('/api/telegram/config');
                const data = await res.json();
                tgBotToken.value = data.bot_token || '';
                tgChatId.value = data.chat_id || '';
                tgInterval.value = data.interval_hours !== undefined ? data.interval_hours : 0;
                tgCustomInterval.value = data.custom_interval_minutes !== undefined ? data.custom_interval_minutes : 0;
                tgGraphHours.value = data.graph_hours !== undefined ? data.graph_hours : 3;
                tgCpuTh.value = data.cpu_threshold !== undefined ? data.cpu_threshold : 0.0;
                tgRamTh.value = data.ram_threshold !== undefined ? data.ram_threshold : 0.0;
                tgLoadTh.value = data.load_threshold !== undefined ? data.load_threshold : 0.0;
                tgLoadAvgType.value = data.load_avg_type !== undefined ? data.load_avg_type : 1;
                tgDiskTh.value = data.disk_threshold !== undefined ? data.disk_threshold : 0.0;
                tgSendCpuGraph.checked = data.send_cpu_graph !== 0;
                tgSendRamGraph.checked = data.send_ram_graph !== 0;
                tgSendLoad1mGraph.checked = data.send_load_1m_graph !== 0;
                tgSendLoad5mGraph.checked = data.send_load_5m_graph !== 0;
                tgSendLoad15mGraph.checked = data.send_load_15m_graph !== 0;
                tgSendNetGraph.checked = data.send_net_graph !== 0;
                tgAlertSendGraph.checked = data.alert_send_graph === 1;
                if (tgEnabled) {
                    tgEnabled.checked = data.enabled !== 0;
                }
                toggleCustomInterval();
            } catch (err) {
                console.error("Failed to load telegram config:", err);
            }
        }

        btnSave.addEventListener('click', async () => {
            const config = {
                bot_token: tgBotToken.value.trim(),
                chat_id: tgChatId.value.trim(),
                interval_hours: parseInt(tgInterval.value, 10) || 0,
                custom_interval_minutes: parseInt(tgCustomInterval.value, 10) || 0,
                graph_hours: parseInt(tgGraphHours.value, 10) || 3,
                cpu_threshold: parseFloat(tgCpuTh.value) || 0.0,
                ram_threshold: parseFloat(tgRamTh.value) || 0.0,
                load_threshold: parseFloat(tgLoadTh.value) || 0.0,
                load_avg_type: parseInt(tgLoadAvgType.value, 10) || 1,
                disk_threshold: parseFloat(tgDiskTh.value) || 0.0,
                send_graph: (tgSendCpuGraph.checked || tgSendRamGraph.checked || tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked || tgSendNetGraph.checked) ? 1 : 0,
                send_sys_graph: (tgSendCpuGraph.checked || tgSendRamGraph.checked || tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked) ? 1 : 0,
                send_net_graph: tgSendNetGraph.checked ? 1 : 0,
                send_cpu_graph: tgSendCpuGraph.checked ? 1 : 0,
                send_ram_graph: tgSendRamGraph.checked ? 1 : 0,
                send_load_graph: (tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked) ? 1 : 0,
                send_load_1m_graph: tgSendLoad1mGraph.checked ? 1 : 0,
                send_load_5m_graph: tgSendLoad5mGraph.checked ? 1 : 0,
                send_load_15m_graph: tgSendLoad15mGraph.checked ? 1 : 0,
                alert_send_graph: tgAlertSendGraph.checked ? 1 : 0,
                enabled: tgEnabled ? (tgEnabled.checked ? 1 : 0) : 1
            };

            if (!config.bot_token || !config.chat_id) {
                alert("Bot Token and Chat ID are required.");
                return;
            }

            btnSave.disabled = true;
            btnSave.textContent = "Saving...";

            try {
                const res = await fetch('/api/telegram/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                const data = await res.json();
                if (data.status === 'success') {
                    alert("Telegram settings saved successfully!");
                    closeOverlay();
                } else {
                    alert(data.message || "Failed to save settings.");
                }
            } catch (err) {
                console.error("Error saving config:", err);
                alert("Network error: " + err.message);
            } finally {
                btnSave.disabled = false;
                btnSave.textContent = "Save Settings";
            }
        });

        btnTest.addEventListener('click', async () => {
            const testPayload = {
                bot_token: tgBotToken.value.trim(),
                chat_id: tgChatId.value.trim(),
                send_graph: (tgSendCpuGraph.checked || tgSendRamGraph.checked || tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked || tgSendNetGraph.checked) ? 1 : 0,
                send_sys_graph: (tgSendCpuGraph.checked || tgSendRamGraph.checked || tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked) ? 1 : 0,
                send_net_graph: tgSendNetGraph.checked ? 1 : 0,
                send_cpu_graph: tgSendCpuGraph.checked ? 1 : 0,
                send_ram_graph: tgSendRamGraph.checked ? 1 : 0,
                send_load_graph: (tgSendLoad1mGraph.checked || tgSendLoad5mGraph.checked || tgSendLoad15mGraph.checked) ? 1 : 0,
                send_load_1m_graph: tgSendLoad1mGraph.checked ? 1 : 0,
                send_load_5m_graph: tgSendLoad5mGraph.checked ? 1 : 0,
                send_load_15m_graph: tgSendLoad15mGraph.checked ? 1 : 0,
                graph_hours: parseInt(tgGraphHours.value, 10) || 3
            };

            if (!testPayload.bot_token || !testPayload.chat_id) {
                alert("Bot Token and Chat ID are required for test.");
                return;
            }

            btnTest.disabled = true;
            btnTest.textContent = "Testing...";

            try {
                const res = await fetch('/api/telegram/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(testPayload)
                });
                const data = await res.json();
                if (data.status === 'success') {
                    alert("Test message sent successfully! Please check your Telegram chat.");
                } else {
                    alert(data.detail || data.message || "Failed to send test message.");
                }
            } catch (err) {
                console.error("Error sending test:", err);
                alert("Network error: " + err.message);
            } finally {
                btnTest.disabled = false;
                btnTest.textContent = "Send Test Message";
            }
        });
    }

    function setupVirtualBrowser() {
        const btnManage = document.getElementById('btnManageBrowser');
        const overlay = document.getElementById('browserOverlay');
        const btnClose = document.getElementById('closeBrowser');

        if (!btnManage || !overlay) return;

        // Open/Close logic
        btnManage.addEventListener('click', () => {
            overlay.classList.remove('hidden');
            checkBrowserStatus();
        });

        btnClose.addEventListener('click', () => {
            overlay.classList.add('hidden');
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });

        // Elements
        const badge = document.getElementById('browserStatusBadge');
        const btnInstall = document.getElementById('btnBrowserInstall');
        const btnUninstall = document.getElementById('btnBrowserUninstall');
        const btnClear = document.getElementById('btnBrowserClear');
        const btnStart = document.getElementById('btnBrowserStart');
        const btnStop = document.getElementById('btnBrowserStop');
        const btnOpen = document.getElementById('btnBrowserOpen');
        const logsPre = document.getElementById('browserLogs');
        const logsBox = document.getElementById('browserLogBox');
        let ws = null;

        function connectLogsWS() {
            if (ws && ws.readyState !== WebSocket.CLOSED) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/api/browser/ws`);
            ws.onmessage = (event) => {
                logsPre.textContent += event.data + "\n";
                // Max lines keep
                const lines = logsPre.textContent.split('\n');
                if (lines.length > 200) {
                    logsPre.textContent = lines.slice(-200).join('\n');
                }
                logsBox.scrollTop = logsBox.scrollHeight;
            };
            ws.onclose = () => { setTimeout(connectLogsWS, 3000); };
        }

        async function checkBrowserStatus() {
            try {
                const res = await fetch("/api/browser/status");
                if (res.ok) {
                    const data = await res.json();
                    updateBrowserUI(data);
                }
            } catch (err) {
                console.error("Failed to fetch browser status:", err);
            }
        }

        function updateBrowserUI(data) {
            // data.state = "not_installed", "running", "stopped"
            if (data.state === "running") {
                badge.textContent = "Running";
                badge.className = "badge badge-success";
                btnInstall.style.display = "none";
                btnStart.style.display = "none";
                btnStop.style.display = "flex";
                btnUninstall.style.display = "block";
                btnOpen.disabled = false;
            } else if (data.state === "stopped") {
                badge.textContent = "Stopped";
                badge.className = "badge badge-warning";
                btnInstall.style.display = "none";
                btnStart.style.display = "flex";
                btnStop.style.display = "none";
                btnUninstall.style.display = "block";
                btnOpen.disabled = true;
            } else {
                badge.textContent = "Not Installed";
                badge.className = "badge badge-error";
                btnInstall.style.display = "flex";
                btnStart.style.display = "none";
                btnStop.style.display = "none";
                btnUninstall.style.display = "none";
                btnOpen.disabled = true;
            }
        }

        async function performAction(action) {
            connectLogsWS();
            const config = {
                user: document.getElementById('browserUser').value || "admin",
                pass: document.getElementById('browserPass').value || "admin",
                res: document.getElementById('browserRes').value,
                quality: document.getElementById('browserQuality').value
            };

            const theBtn = action === 'install' ? btnInstall : (action === 'start' ? btnStart : (action === 'stop' ? btnStop : (action === 'clear_cache' ? btnClear : btnUninstall)));
            const originalText = theBtn.textContent;
            theBtn.disabled = true;

            // Handle element structure for button loaders
            if (theBtn.querySelector('.btn-text')) {
                theBtn.querySelector('.btn-text').textContent = "Working...";
            } else {
                theBtn.textContent = "Working...";
            }

            try {
                const res = await fetch("/api/browser/action", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action, config })
                });
                if (res.ok) {
                    const data = await res.json();
                    updateBrowserUI(data);
                } else {
                    const err = await res.json();
                    alert("Error: " + (err.detail || "Action failed"));
                }
            } catch (err) {
                alert("Network error: " + err.message);
            } finally {
                theBtn.disabled = false;
                if (theBtn.querySelector('.btn-text')) {
                    theBtn.querySelector('.btn-text').textContent = action === 'install' ? "Install / Update" : "Working..."; // fallback
                } else {
                    theBtn.textContent = originalText;
                }
            }
        }

        btnInstall.addEventListener('click', () => performAction('install'));
        btnUninstall.addEventListener('click', () => {
            if (confirm("Uninstall Virtual Browser? This will remove the container.")) performAction('uninstall');
        });
        btnClear.addEventListener('click', () => {
            if (confirm("Clear Docker cache and completely remove Chromium images?")) performAction('clear_cache');
        });
        btnStart.addEventListener('click', () => performAction('start'));
        btnStop.addEventListener('click', () => performAction('stop'));

        btnOpen.addEventListener('click', () => {
            window.open("https://" + window.location.host + "/browser/", "_blank");
        });

        // Initial fetch
        checkBrowserStatus();
    }

    // ─── Detached Self Update & Reinstall ────────────────────────────────────
    function setupSelfUpdate() {
        const btnUpdate = document.getElementById("btnUpdatePanel");
        const btnReinstall = document.getElementById("btnReinstallPanel");
        const overlay = document.getElementById("updateOverlay");
        const statusText = document.getElementById("updateStatusText");
        const progressBar = document.getElementById("updateProgressBar");
        const progressPercent = document.getElementById("updateProgressPercent");

        if (!overlay || !statusText || !progressBar || !progressPercent) return;

        let updateInterval = null;
        let pollInterval = null;
        let currentProgress = 0;
        let isUpdating = false;

        async function checkServerOnline() {
            try {
                // Fetch simple lightweight endpoint without caching
                const res = await fetch("/api/current?t=" + Date.now());
                if (res.status === 200) {
                    return true;
                }
            } catch (err) {
                // Server is down
            }
            return false;
        }

        async function getServerVersion() {
            try {
                const res = await fetch("/api/current?t=" + Date.now());
                if (res.status === 200) {
                    const data = await res.json();
                    return data.version || null;
                }
            } catch (err) {
                // Server is down
            }
            return null;
        }

        function startPolling() {
            const currentVersion = document.getElementById("panelVersion")?.textContent?.replace(/^v/, "").trim() || null;
            let phase = "waiting_offline"; // Phase 1: wait for server to go offline
            let offlineAttempts = 0;
            let onlineAttempts = 0;
            const maxOfflineWait = 15;  // 30 seconds max to go offline
            const maxOnlineWait = 60;   // 120 seconds max to come back

            pollInterval = setInterval(async () => {
                const version = await getServerVersion();

                if (phase === "waiting_offline") {
                    offlineAttempts += 1;
                    statusText.textContent = `Waiting for service to restart... (${offlineAttempts * 2}s)`;

                    if (version === null) {
                        // Server went offline - service is restarting
                        phase = "waiting_online";
                        statusText.textContent = "Service restarting... waiting for it to come back online.";
                    } else if (currentVersion && version !== currentVersion) {
                        // Version already changed! It restarted very quickly.
                        clearInterval(pollInterval);
                        if (updateInterval) clearInterval(updateInterval);
                        progressBar.style.width = "100%";
                        progressPercent.textContent = "100%";
                        statusText.textContent = `Updated to ${version}! Refreshing...`;
                        setTimeout(() => { window.location.reload(); }, 1500);
                    } else if (offlineAttempts >= maxOfflineWait) {
                        // Server never went offline - maybe it restarted too fast and version didn't change (e.g. reinstall)
                        phase = "waiting_version";
                        statusText.textContent = "Checking for new version...";
                    }

                } else if (phase === "waiting_online") {
                    onlineAttempts += 1;
                    statusText.textContent = `Service restarting... (${onlineAttempts * 2}s)`;

                    if (version !== null) {
                        // Server is back online
                        clearInterval(pollInterval);
                        if (updateInterval) clearInterval(updateInterval);
                        progressBar.style.width = "100%";
                        progressPercent.textContent = "100%";
                        statusText.textContent = "Update complete! Refreshing...";
                        setTimeout(() => { window.location.reload(); }, 1500);
                    } else if (onlineAttempts >= maxOnlineWait) {
                        clearInterval(pollInterval);
                        if (updateInterval) clearInterval(updateInterval);
                        statusText.textContent = "Update timed out. Please refresh manually.";
                    }

                } else if (phase === "waiting_version") {
                    onlineAttempts += 1;
                    statusText.textContent = `Checking for updated version... (${onlineAttempts * 2}s)`;

                    // Reload if version changed, or after 30 more seconds
                    if ((version && currentVersion && version !== currentVersion) || onlineAttempts >= 15) {
                        clearInterval(pollInterval);
                        if (updateInterval) clearInterval(updateInterval);
                        progressBar.style.width = "100%";
                        progressPercent.textContent = "100%";
                        statusText.textContent = version !== currentVersion
                            ? `Updated to ${version}! Refreshing...`
                            : "Update complete! Refreshing...";
                        setTimeout(() => { window.location.reload(); }, 1500);
                    }
                }
            }, 2000);
        }

        async function triggerAction(skipGit) {
            if (isUpdating) return;
            const actionText = skipGit ? "نصب مجدد (Reinstall)" : "به‌روزرسانی (Update)";
            const confirmed = confirm(`آیا مایل به ${actionText} مانیتور سرور هستید؟\nاین عملیات حدود ۲۰ تا ۳۰ ثانیه زمان می‌برد و پنل به طور خودکار ریستارت خواهد شد.`);
            if (!confirmed) return;

            isUpdating = true;
            overlay.classList.remove("hidden");
            document.body.style.overflow = "hidden";
            progressBar.style.width = "0%";
            progressPercent.textContent = "0%";
            currentProgress = 0;
            statusText.textContent = "Contacting backend and launching detached updater...";

            // Smooth fake progress bar for visual feedback (0 to 95% over 22 seconds)
            // 22000ms / 95 steps = ~230ms per 1% increment
            updateInterval = setInterval(() => {
                if (currentProgress < 95) {
                    currentProgress += 1;
                    progressBar.style.width = currentProgress + "%";
                    progressPercent.textContent = currentProgress + "%";
                    
                    if (currentProgress < 30) {
                        statusText.textContent = skipGit ? `Analyzing local files... (${currentProgress}%)` : `Fetching latest files from GitHub... (${currentProgress}%)`;
                    } else if (currentProgress < 60) {
                        statusText.textContent = `Installing Python dependencies... (${currentProgress}%)`;
                    } else {
                        statusText.textContent = `Rebuilding systemd service... (${currentProgress}%)`;
                    }
                }
            }, 230);

            try {
                const resp = await fetch(`/api/update?skip_git=${skipGit}`, {
                    method: "POST"
                });

                // Check for Docker environment error
                if (resp.ok) {
                    const data = await resp.json().catch(() => null);
                    if (data && data.error === "docker") {
                        // Hide overlay, show Docker instructions
                        clearInterval(updateInterval);
                        overlay.classList.add("hidden");
                        isUpdating = false;
                        alert("⚠️ Docker Installation Detected\n\nThis panel is running inside Docker and cannot self-update.\n\nTo update, run on your host server:\n\n  docker-compose pull\n  docker-compose up -d");
                        return;
                    }
                }
                
                // If successful or if it fails due to network termination, start polling
                startPolling();
            } catch (err) {
                // Connection reset due to systemd restart
                console.log("Connection reset due to server restart. Starting offline polling...");
                startPolling();
            }
        }

        if (btnUpdate) {
            btnUpdate.addEventListener("click", () => triggerAction(false));
        }
        if (btnReinstall) {
            btnReinstall.addEventListener("click", () => triggerAction(true));
        }
    }

    let hasCheckedForUpdates = false;
    function checkForUpdates(currentVersion) {
        if (!currentVersion) return;
        if (hasCheckedForUpdates) return;
        hasCheckedForUpdates = true;

        fetch("https://api.github.com/repos/isitanand/syspulse-infrastructure-monitor/releases/latest")
            .then(res => res.json())
            .then(release => {
                if (release && release.tag_name) {
                    const latest = release.tag_name.replace(/^v/, "");
                    const current = currentVersion.replace(/^v/, "");
                    
                    const parseVersion = (v) => v.split(".").map(Number);
                    const currParts = parseVersion(current);
                    const lateParts = parseVersion(latest);
                    
                    let hasNewUpdate = false;
                    for (let i = 0; i < Math.max(currParts.length, lateParts.length); i++) {
                        const c = currParts[i] || 0;
                        const l = lateParts[i] || 0;
                        if (l > c) {
                            hasNewUpdate = true;
                            break;
                        } else if (c > l) {
                            break;
                        }
                    }

                    if (hasNewUpdate) {
                        const btnUpdate = document.getElementById("btnUpdatePanel");
                        if (btnUpdate) {
                            let badge = document.getElementById("updateBadge");
                            if (!badge) {
                                badge = document.createElement("span");
                                badge.id = "updateBadge";
                                badge.className = "update-available-badge";
                                badge.textContent = `New: v${latest}`;
                                btnUpdate.style.position = "relative";
                                btnUpdate.appendChild(badge);
                            }
                        }
                    }
                }
            })
            .catch(err => console.log("Failed to check GitHub releases:", err));
    }

    function setupSpeedTest() {
        const btnSpeedTest = document.getElementById("btnSpeedTest");
        const serverSelect = document.getElementById("speedtestServer");
        const pingSpan = document.getElementById("speedtestPing");
        const downSpan = document.getElementById("speedtestDownload");
        const upSpan = document.getElementById("speedtestUpload");
        const btnText = document.getElementById("btnSpeedTestText");
        const btnLoader = document.getElementById("btnSpeedTestLoader");

        if (!btnSpeedTest || !serverSelect) return;

        let isRunning = false;

        // Fetch servers
        fetch("/api/speedtest/servers")
            .then(res => res.json())
            .then(data => {
                if (data.status === "success" && data.servers) {
                    serverSelect.innerHTML = '<option value="">Auto Select Best</option>';
                    data.servers.forEach(srv => {
                        const opt = document.createElement("option");
                        opt.value = srv.id;
                        opt.textContent = `${srv.sponsor} - ${srv.name} (${srv.country})`;
                        serverSelect.appendChild(opt);
                    });
                } else {
                    serverSelect.innerHTML = '<option value="">Failed to load servers</option>';
                }
            })
            .catch(err => {
                serverSelect.innerHTML = '<option value="">Error loading servers</option>';
            });

        btnSpeedTest.addEventListener("click", async () => {
            if (isRunning) return;
            isRunning = true;
            btnSpeedTest.disabled = true;
            btnText.textContent = "Testing...";
            btnLoader.classList.remove("hidden");

            pingSpan.textContent = "Testing...";
            downSpan.textContent = "Testing...";
            upSpan.textContent = "Testing...";

            const serverId = serverSelect.value;
            let url = "/api/speedtest/run";
            if (serverId) url += `?server_id=${encodeURIComponent(serverId)}`;

            try {
                const res = await fetch(url);
                const data = await res.json();
                if (data.status === "success" && data.result) {
                    pingSpan.textContent = `${data.result.ping.toFixed(1)} ms`;
                    downSpan.textContent = `${data.result.download.toFixed(2)} Mbps`;
                    upSpan.textContent = `${data.result.upload.toFixed(2)} Mbps`;
                } else {
                    pingSpan.textContent = "Error";
                    downSpan.textContent = "Error";
                    upSpan.textContent = "Error";
                    alert(data.error || "Speed test failed");
                }
            } catch (err) {
                console.error("Speed test fetch error:", err);
                pingSpan.textContent = "Error";
                downSpan.textContent = "Error";
                upSpan.textContent = "Error";
                alert("Network error: " + err.message);
            } finally {
                isRunning = false;
                btnSpeedTest.disabled = false;
                btnText.textContent = "Run Test";
                btnLoader.classList.add("hidden");
            }
        });
    }

    let geoLeafletMap = null;

    function setupExtendedFeatures() {
        // 1. Database & Web Server Metrics Modal
        const btnDbWebMetricsOpen = document.getElementById("btnDbWebMetricsOpen");
        const btnCloseDbWebMetrics = document.getElementById("btnCloseDbWebMetrics");
        const dbWebMetricsModal = document.getElementById("dbWebMetricsModal");

        if (btnDbWebMetricsOpen && dbWebMetricsModal) {
            btnDbWebMetricsOpen.addEventListener("click", () => {
                dbWebMetricsModal.classList.remove("hidden");
                fetchDbWebMetrics();
            });
        }
        if (btnCloseDbWebMetrics && dbWebMetricsModal) {
            btnCloseDbWebMetrics.addEventListener("click", () => dbWebMetricsModal.classList.add("hidden"));
        }

        async function fetchDbWebMetrics() {
            try {
                const res = await fetch("/api/metrics/extended");
                if (!res.ok) return;
                const data = await res.json();
                
                // PostgreSQL
                const pg = data.postgres || {};
                const pgBadge = document.getElementById("pgStatusBadge");
                if (pgBadge) {
                    pgBadge.textContent = pg.status === "online" ? "Online" : "Offline";
                    pgBadge.className = pg.status === "online" ? "v2ray-status-badge active" : "v2ray-status-badge";
                }
                document.getElementById("pgActiveConn") && (document.getElementById("pgActiveConn").textContent = pg.active_connections || 0);
                document.getElementById("pgMaxConn") && (document.getElementById("pgMaxConn").textContent = pg.max_connections || 100);
                document.getElementById("pgIdleConn") && (document.getElementById("pgIdleConn").textContent = pg.idle_connections || 0);
                document.getElementById("pgCacheHit") && (document.getElementById("pgCacheHit").textContent = (pg.cache_hit_ratio || 0) + "%");

                // Nginx
                const ng = data.nginx || {};
                const ngBadge = document.getElementById("nginxStatusBadge");
                if (ngBadge) {
                    ngBadge.textContent = ng.status === "online" ? "Online" : "Offline";
                    ngBadge.className = ng.status === "online" ? "v2ray-status-badge active" : "v2ray-status-badge";
                }
                document.getElementById("nginxActiveConn") && (document.getElementById("nginxActiveConn").textContent = ng.active_connections || 0);
                document.getElementById("nginxReading") && (document.getElementById("nginxReading").textContent = ng.reading || 0);
                document.getElementById("nginxWriting") && (document.getElementById("nginxWriting").textContent = ng.writing || 0);
                document.getElementById("nginxWaiting") && (document.getElementById("nginxWaiting").textContent = ng.waiting || 0);
                document.getElementById("nginxErrors") && (document.getElementById("nginxErrors").textContent = ng.errors_502_504 || 0);
            } catch (err) {
                console.error("DbWebMetrics Error:", err);
            }
        }

        // 2. Network Diagnostics & Geo-IP Map Modal
        const btnDiagnosticsOpen = document.getElementById("btnDiagnosticsOpen");
        const btnCloseDiagnostics = document.getElementById("btnCloseDiagnostics");
        const diagnosticsModal = document.getElementById("diagnosticsModal");
        const btnRunPing = document.getElementById("btnRunPing");
        const btnRunMtr = document.getElementById("btnRunMtr");
        const btnLoadGeoMap = document.getElementById("btnLoadGeoMap");
        const btnRunVisualTrace = document.getElementById("btnRunVisualTrace");
        const diagTargetInput = document.getElementById("diagTargetInput");
        const diagResultsContainer = document.getElementById("diagResultsContainer");

        if (btnDiagnosticsOpen && diagnosticsModal) {
            btnDiagnosticsOpen.addEventListener("click", () => diagnosticsModal.classList.remove("hidden"));
        }
        if (btnCloseDiagnostics && diagnosticsModal) {
            btnCloseDiagnostics.addEventListener("click", () => diagnosticsModal.classList.add("hidden"));
        }

        if (btnRunPing) {
            btnRunPing.addEventListener("click", async () => {
                const target = diagTargetInput ? diagTargetInput.value.trim() : "8.8.8.8";
                if (!target) return alert("Please enter a valid target IP or Domain.");
                diagResultsContainer.style.display = "block";
                diagResultsContainer.textContent = `Running Ping to ${target}...`;
                try {
                    const res = await fetch("/api/diagnostics/ping", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ target })
                    });
                    const data = await res.json();
                    if (data.raw) {
                        diagResultsContainer.textContent = data.raw;
                    } else if (data.error) {
                        diagResultsContainer.textContent = "Error: " + data.error;
                    }
                } catch (e) {
                    diagResultsContainer.textContent = "Request Error: " + e.message;
                }
            });
        }

        if (btnRunMtr) {
            btnRunMtr.addEventListener("click", async () => {
                const target = diagTargetInput ? diagTargetInput.value.trim() : "8.8.8.8";
                if (!target) return alert("Please enter a valid target IP or Domain.");
                diagResultsContainer.style.display = "block";
                diagResultsContainer.textContent = `Running MTR Trace to ${target}...`;
                try {
                    const res = await fetch("/api/diagnostics/mtr", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ target })
                    });
                    const data = await res.json();
                    if (data.raw) {
                        diagResultsContainer.textContent = data.raw;
                    } else if (data.error) {
                        diagResultsContainer.textContent = "Error: " + data.error;
                    }
                } catch (e) {
                    diagResultsContainer.textContent = "Request Error: " + e.message;
                }
            });
        }

        if (btnLoadGeoMap) {
            btnLoadGeoMap.addEventListener("click", fetchAndRenderGeoMap);
        }
        if (btnRunVisualTrace) {
            btnRunVisualTrace.addEventListener("click", runVisualTraceroute);
        }

        async function runVisualTraceroute() {
            const target = diagTargetInput ? diagTargetInput.value.trim() : "8.8.8.8";
            if (!target) return alert("Please enter a valid target IP or Domain.");
            
            diagResultsContainer.style.display = "block";
            diagResultsContainer.textContent = `Running Visual Traceroute to ${target}... (This may take a minute)`;
            
            try {
                const res = await fetch("/api/diagnostics/visual-traceroute", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ target })
                });
                const data = await res.json();
                if (!data.success) {
                    diagResultsContainer.textContent = "Error: " + (data.error || "Unknown error");
                    return;
                }
                
                diagResultsContainer.textContent = "Visual Traceroute completed! Check the map below.";
                
                if (window.L && document.getElementById("geoMap")) {
                    if (!geoLeafletMap) {
                        geoLeafletMap = L.map("geoMap", { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120 }).setView([20, 0], 2);
                        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                            maxZoom: 18,
                            attribution: '© OpenStreetMap'
                        }).addTo(geoLeafletMap);
                    }
                    
                    if (window.geoMapLayerGroup) {
                        geoMapLayerGroup.clearLayers();
                    } else {
                        window.geoMapLayerGroup = L.layerGroup().addTo(geoLeafletMap);
                    }
                    
                    const latlngs = [];
                    data.route.forEach((hop, index) => {
                        if (hop.lat && hop.lon) {
                            latlngs.push([hop.lat, hop.lon]);
                            L.marker([hop.lat, hop.lon])
                             .addTo(window.geoMapLayerGroup)
                             .bindPopup(`<b>Hop ${hop.hop}: ${hop.ip}</b><br/>${hop.city}, ${hop.country}<br/>ISP: ${hop.isp}<br/>Avg Latency: ${hop.avg_ms} ms`);
                        }
                    });
                    
                    if (latlngs.length > 0) {
                        L.polyline(latlngs, {color: '#f59e0b', weight: 4, opacity: 0.8, dashArray: '10, 10'}).addTo(window.geoMapLayerGroup);
                        geoLeafletMap.fitBounds(latlngs, {padding: [50, 50]});
                    }
                    
                    setTimeout(() => geoLeafletMap.invalidateSize(), 300);
                }
            } catch (e) {
                console.error("VisualTrace Error:", e);
                diagResultsContainer.textContent = "Request Error: " + e.message;
            }
        }

        async function fetchAndRenderGeoMap() {
            try {
                const res = await fetch("/api/network/connections-geo");
                const data = await res.json();
                const conns = data.connections || [];
                
                if (window.L && document.getElementById("geoMap")) {
                    if (!geoLeafletMap) {
                        geoLeafletMap = L.map("geoMap", { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120 }).setView([20, 0], 2);
                        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                            maxZoom: 18,
                            attribution: '© OpenStreetMap'
                        }).addTo(geoLeafletMap);
                    }
                    if (window.geoMapLayerGroup) {
                        geoMapLayerGroup.clearLayers();
                    } else {
                        window.geoMapLayerGroup = L.layerGroup().addTo(geoLeafletMap);
                    }
                    conns.forEach(c => {
                        if (c.lat && c.lon) {
                            L.marker([c.lat, c.lon])
                             .addTo(window.geoMapLayerGroup)
                             .bindPopup(`<b>${c.ip}</b> (${c.country}, ${c.city})<br/>Port: ${c.port} | Proto: ${c.proto}<br/>ISP: ${c.isp}`);
                        }
                    });
                    setTimeout(() => geoLeafletMap.invalidateSize(), 300);
                }
            } catch (e) {
                console.error("GeoMap Error:", e);
            }
        }

        // 3. Security & Live Logs Modal
        const btnSecurityLogsOpen = document.getElementById("btnSecurityLogsOpen");
        const btnCloseSecurityLogs = document.getElementById("btnCloseSecurityLogs");
        const securityLogsModal = document.getElementById("securityLogsModal");
        const btnFetchLogs = document.getElementById("btnFetchLogs");
        const logSourceSelect = document.getElementById("logSourceSelect");
        const logSearchInput = document.getElementById("logSearchInput");
        const logContentBox = document.getElementById("logContentBox");

        if (btnSecurityLogsOpen && securityLogsModal) {
            btnSecurityLogsOpen.addEventListener("click", () => {
                securityLogsModal.classList.remove("hidden");
                fetchSecurityData();
                fetchLogs();
            });
        }
        if (btnCloseSecurityLogs && securityLogsModal) {
            btnCloseSecurityLogs.addEventListener("click", () => securityLogsModal.classList.add("hidden"));
        }

        if (btnFetchLogs) {
            btnFetchLogs.addEventListener("click", fetchLogs);
        }

        async function fetchSecurityData() {
            // Fail2ban
            try {
                const res = await fetch("/api/security/fail2ban");
                const data = await res.json();
                const container = document.getElementById("fail2banList");
                if (container) {
                    if (data.status === "active" && data.jails && data.jails.length > 0) {
                        let html = "";
                        data.jails.forEach(j => {
                            html += `<div><strong>${j.name}</strong>: ${j.banned_count} banned</div>`;
                            if (j.banned_ips && j.banned_ips.length > 0) {
                                j.banned_ips.forEach(ip => {
                                    html += `<div style="padding-left:10px; color:#ef4444;">• ${ip} <button onclick="unbanIp('${j.name}', '${ip}')" style="font-size:0.75rem; padding:1px 5px; cursor:pointer;">Unban</button></div>`;
                                });
                            }
                        });
                        container.innerHTML = html;
                    } else {
                        container.innerHTML = `<span style="color:var(--text-muted);">No active Fail2ban jails or no banned IPs.</span>`;
                    }
                }
            } catch (e) {
                console.error("Fail2ban Error:", e);
            }

            // SSH Sessions
            try {
                const res = await fetch("/api/security/ssh-sessions");
                const data = await res.json();
                const container = document.getElementById("sshSessionsList");
                if (container) {
                    if (data.sessions && data.sessions.length > 0) {
                        let html = "";
                        data.sessions.forEach(s => {
                            html += `<div><strong>${s.user}</strong> (${s.tty}) from <span style="color:#10b981;">${s.ip}</span> [${s.login_time}]</div>`;
                        });
                        container.innerHTML = html;
                    } else {
                        container.innerHTML = `<span style="color:var(--text-muted);">No active SSH sessions found.</span>`;
                    }
                }
            } catch (e) {
                console.error("SSH Sessions Error:", e);
            }
        }

        window.unbanIp = async function(jail, ip) {
            if (!confirm(`Unban IP ${ip} from jail ${jail}?`)) return;
            try {
                const res = await fetch("/api/security/fail2ban/unban", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jail, ip })
                });
                const data = await res.json();
                alert(data.success ? "IP unbanned successfully!" : ("Failed: " + data.output));
                fetchSecurityData();
            } catch (e) {
                alert("Error: " + e.message);
            }
        };

        async function fetchLogs() {
            if (!logContentBox) return;
            const src = logSourceSelect ? logSourceSelect.value : "syslog";
            const search = logSearchInput ? logSearchInput.value.trim() : "";
            logContentBox.textContent = `Fetching ${src} logs...`;
            try {
                const res = await fetch(`/api/logs/tail?source=${src}&lines=100&search=${encodeURIComponent(search)}`);
                const data = await res.json();
                if (data.lines && data.lines.length > 0) {
                    logContentBox.textContent = data.lines.join("\n");
                    logContentBox.scrollTop = logContentBox.scrollHeight;
                } else {
                    logContentBox.textContent = "No log entries found.";
                }
            } catch (e) {
                logContentBox.textContent = "Error fetching logs: " + e.message;
            }
        }

        // 4. Docker Container Manager Modal
        const btnDockerOpen = document.getElementById("btnDockerOpen");
        const btnCloseDocker = document.getElementById("btnCloseDocker");
        const dockerModal = document.getElementById("dockerModal");

        if (btnDockerOpen && dockerModal) {
            btnDockerOpen.addEventListener("click", () => {
                dockerModal.classList.remove("hidden");
                fetchDockerContainers();
            });
        }
        if (btnCloseDocker && dockerModal) {
            btnCloseDocker.addEventListener("click", () => dockerModal.classList.add("hidden"));
        }

        async function fetchDockerContainers() {
            const container = document.getElementById("dockerContainersContainer");
            if (!container) return;
            container.innerHTML = "Loading Docker containers...";
            try {
                const res = await fetch("/api/docker/containers");
                const data = await res.json();
                if (!data.installed) {
                    container.innerHTML = `<div style="color:var(--text-muted); padding:10px;">Docker is not installed or docker daemon is offline.</div>`;
                    return;
                }
                if (!data.containers || data.containers.length === 0) {
                    container.innerHTML = `<div style="color:var(--text-muted); padding:10px;">No containers found on host.</div>`;
                    return;
                }
                let html = "";
                data.containers.forEach(c => {
                    const isRunning = c.state === "running";
                    html += `
                    <div style="padding:12px; border-radius:10px; background:var(--bg-card); border:1px solid var(--border-color); display:flex; align-items:center; justify-content:space-between;">
                        <div>
                            <div style="font-weight:600; font-size:0.95rem;">${c.name} <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">(${c.image})</span></div>
                            <div style="font-size:0.8rem; color:${isRunning ? '#10b981' : '#ef4444'};">${c.status}</div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button onclick="dockerAction('${c.id}', '${isRunning ? 'stop' : 'start'}')" class="benchmark-btn" style="padding:4px 10px; font-size:0.8rem; background:${isRunning ? '#ef4444' : '#10b981'};">${isRunning ? 'Stop' : 'Start'}</button>
                            <button onclick="dockerAction('${c.id}', 'restart')" class="benchmark-btn" style="padding:4px 10px; font-size:0.8rem; background:#f59e0b;">Restart</button>
                            <button onclick="dockerAction('${c.id}', 'logs')" class="benchmark-btn" style="padding:4px 10px; font-size:0.8rem; background:#3b82f6;">Logs</button>
                        </div>
                    </div>`;
                });
                container.innerHTML = html;
            } catch (e) {
                container.innerHTML = "Error fetching docker containers: " + e.message;
            }
        }

        window.dockerAction = async function(cid, action) {
            try {
                const res = await fetch("/api/docker/action", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ container_id: cid, action: action })
                });
                const data = await res.json();
                if (action === "logs") {
                    alert(data.logs || "No logs returned.");
                } else {
                    alert(data.success ? `Container ${action}ed successfully!` : ("Action failed: " + data.output));
                    fetchDockerContainers();
                }
            } catch (e) {
                alert("Error: " + e.message);
            }
        };
    }

    // ─── Web SSH & Emergency Console ──────────────────────────────────────────
    function setupWebSshTerminal() {
        const btnSSH = document.getElementById("btnSSH");
        const btnConsole = document.getElementById("btnConsole");
        const overlay = document.getElementById("sshTerminalOverlay");
        const closeBtn = document.getElementById("closeSshTerminal");
        const modalBox = document.getElementById("sshTerminalModalBox");
        const btnFullscreen = document.getElementById("btnSshFullscreen");
        const termBox = document.getElementById("sshTerminalBox");
        const modalTitle = document.getElementById("sshTerminalTitle");
        const controlsDiv = document.getElementById("sshTerminalControls");

        const titleInput = document.getElementById("sshTitle");
        const hostInput = document.getElementById("sshHost");
        const portInput = document.getElementById("sshPort");
        const userInput = document.getElementById("sshUser");
        const passInput = document.getElementById("sshPass");
        const btnConnect = document.getElementById("btnSshConnect");
        const btnDisconnect = document.getElementById("btnSshDisconnect");
        const savedSelect = document.getElementById("sshSavedSessionsSelect");
        const btnSaveSession = document.getElementById("btnSaveSshSession");
        const btnDeleteSession = document.getElementById("btnDeleteSshSession");

        const quickCardsContainer = document.getElementById("sshQuickCardsContainer");
        const sessionCountSpan = document.getElementById("sshSessionCount");

        if (!btnSSH || !overlay || !termBox) return;

        let term = null;
        let fitAddon = null;
        let ws = null;
        let currentMode = "ssh"; // "ssh" or "console"
        let activeBookmarks = [];
        let selectedBookmarkId = null;

        function escapeHtml(str) {
            if (!str) return "";
            return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        }

        async function loadSavedSessions() {
            let bookmarks = [];
            try {
                const res = await fetch("/api/ssh/bookmarks");
                if (res.ok) {
                    const data = await res.json();
                    bookmarks = data.bookmarks || [];
                }
            } catch (e) {
                console.warn("Server bookmarks fetch failed, falling back to localStorage", e);
            }

            // Sync from localStorage if server bookmarks are empty
            if (bookmarks.length === 0) {
                try {
                    const localSaved = JSON.parse(localStorage.getItem("ssh_bookmarks") || "[]");
                    if (localSaved.length > 0) {
                        const syncRes = await fetch("/api/ssh/bookmarks/sync", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(localSaved)
                        });
                        if (syncRes.ok) {
                            const syncData = await syncRes.json();
                            bookmarks = syncData.bookmarks || [];
                        }
                    }
                } catch (err) {}
            }

            // Cache locally
            try {
                localStorage.setItem("ssh_bookmarks", JSON.stringify(bookmarks));
            } catch (e) {}

            activeBookmarks = bookmarks;
            renderBookmarksUI();
        }

        function renderBookmarksUI() {
            if (sessionCountSpan) {
                sessionCountSpan.textContent = `${activeBookmarks.length} session${activeBookmarks.length === 1 ? '' : 's'}`;
            }

            // 2. Render Rectangle Cards above (Matching Image 2 design with orange rounded icon box + Title + Host IP)
            if (quickCardsContainer) {
                quickCardsContainer.innerHTML = "";
                if (activeBookmarks.length === 0) {
                    quickCardsContainer.innerHTML = `
                        <div style="font-size: 0.78rem; color: #64748b; padding: 6px 8px; font-style: italic;">
                            No saved SSH sessions. Enter details below & click "+ Save" to bookmark for all browsers.
                        </div>
                    `;
                } else {
                    activeBookmarks.forEach((b, idx) => {
                        const card = document.createElement("div");
                        card.className = "ssh-card-item";
                        if (b.id !== undefined && b.id === selectedBookmarkId) {
                            card.classList.add("active");
                        }

                        card.innerHTML = `
                            <div class="ssh-card-icon-box">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                                    <line x1="8" y1="21" x2="16" y2="21"></line>
                                    <line x1="12" y1="17" x2="12" y2="21"></line>
                                    <polyline points="7 8 10 11 7 14"></polyline>
                                    <line x1="12" y1="14" x2="15" y2="14"></line>
                                </svg>
                            </div>
                            <div class="ssh-card-info">
                                <div class="ssh-card-title" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</div>
                                <div class="ssh-card-sub" title="${escapeHtml(b.host)} (${escapeHtml(b.user)})">${escapeHtml(b.host)}</div>
                            </div>
                            <button class="ssh-card-del-btn" title="Delete bookmark">×</button>
                        `;

                        // Select on card click
                        card.addEventListener("click", (e) => {
                            if (e.target.closest(".ssh-card-del-btn")) return;
                            selectSession(b, idx);
                        });

                        // Connect on double-click
                        card.addEventListener("dblclick", () => {
                            selectSession(b, idx);
                            connectSshWs();
                        });

                        // Direct Delete button click
                        const delBtn = card.querySelector(".ssh-card-del-btn");
                        if (delBtn) {
                            delBtn.addEventListener("click", async (e) => {
                                e.stopPropagation();
                                if (confirm(`Delete bookmark "${b.title}"?`)) {
                                    await deleteBookmark(b.id, idx);
                                }
                            });
                        }

                        quickCardsContainer.appendChild(card);
                    });
                }
            }
        }

        function selectSession(b, idx) {
            selectedBookmarkId = b.id !== undefined ? b.id : idx;
            if (titleInput) titleInput.value = b.title || "";
            if (hostInput) hostInput.value = b.host || "127.0.0.1";
            if (portInput) portInput.value = b.port || "22";
            if (userInput) userInput.value = b.user || "root";
            if (passInput) passInput.value = b.pass || "";
            if (btnDeleteSession) btnDeleteSession.style.display = "inline-block";

            renderBookmarksUI();
        }

        async function deleteBookmark(bId, idx) {
            try {
                if (bId !== undefined) {
                    const res = await fetch(`/api/ssh/bookmarks/${bId}`, { method: "DELETE" });
                    if (res.ok) {
                        const data = await res.json();
                        activeBookmarks = data.bookmarks || [];
                    }
                } else {
                    activeBookmarks.splice(idx, 1);
                }
            } catch (e) {
                activeBookmarks.splice(idx, 1);
            }

            try {
                localStorage.setItem("ssh_bookmarks", JSON.stringify(activeBookmarks));
            } catch(e){}

            selectedBookmarkId = null;
            if (btnDeleteSession) btnDeleteSession.style.display = "none";
            if (titleInput) titleInput.value = "";
            renderBookmarksUI();
        }

        if (btnSaveSession) {
            btnSaveSession.addEventListener("click", async () => {
                const host = hostInput ? hostInput.value.trim() : "";
                const port = portInput ? parseInt(portInput.value.trim(), 10) || 22 : 22;
                const user = userInput ? userInput.value.trim() : "root";
                const pass = passInput ? passInput.value : "";
                let title = titleInput ? titleInput.value.trim() : "";

                if (!host) {
                    alert("Please enter Host first.");
                    return;
                }

                if (!title) {
                    title = prompt("Enter a title for this SSH session (e.g., OVH Germany, Backup VPS):", `${user}@${host}`);
                    if (!title) return;
                    if (titleInput) titleInput.value = title.trim();
                }

                const payload = {
                    id: selectedBookmarkId,
                    title: title.trim(),
                    host: host,
                    port: port,
                    user: user,
                    pass: pass
                };

                try {
                    const res = await fetch("/api/ssh/bookmarks", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
                    if (res.ok) {
                        const data = await res.json();
                        activeBookmarks = data.bookmarks || [];
                    }
                } catch (e) {
                    console.error("Save bookmark failed", e);
                }

                try {
                    localStorage.setItem("ssh_bookmarks", JSON.stringify(activeBookmarks));
                } catch(e){}

                renderBookmarksUI();
                alert(`Saved session "${title}" successfully!`);
            });
        }

        if (btnDeleteSession) {
            btnDeleteSession.addEventListener("click", async () => {
                // Delete button functionality (if used) now relies on selectedBookmarkId instead of dropdown
                if (selectedBookmarkId === null) return;
                let target = null;
                let tIdx = -1;
                for (let i=0; i<activeBookmarks.length; i++) {
                    if (activeBookmarks[i].id === selectedBookmarkId) {
                        target = activeBookmarks[i];
                        tIdx = i;
                        break;
                    }
                }
                if (target === null && typeof selectedBookmarkId === 'number') {
                    target = activeBookmarks[selectedBookmarkId];
                    tIdx = selectedBookmarkId;
                }
                
                if (target && confirm(`Delete bookmark "${target.title}"?`)) {
                    await deleteBookmark(target ? target.id : undefined, tIdx);
                }
            });
        }

        loadSavedSessions();

        if (btnFullscreen && modalBox) {
            btnFullscreen.addEventListener("click", () => {
                modalBox.classList.toggle("terminal-fullscreen");
                if (fitAddon) setTimeout(() => fitAddon.fit(), 100);
                if (ws && ws.readyState === WebSocket.OPEN && term) {
                    setTimeout(() => {
                        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                    }, 120);
                }
            });
        }

        function openTerminalModal(mode) {
            currentMode = mode;
            overlay.classList.remove("hidden");
            loadSavedSessions();

            if (modalTitle) {
                modalTitle.textContent = mode === "console" ? "Emergency Server Console (Local TTY)" : "Web SSH Terminal";
            }

            if (controlsDiv) {
                controlsDiv.style.display = mode === "console" ? "none" : "flex";
            }

            if (!term) {
                initXterm();
            } else {
                term.reset();
                if (fitAddon) setTimeout(() => fitAddon.fit(), 100);
            }

            if (mode === "console") {
                connectConsoleWs();
            } else {
                term.writeln("\x1b[32m=== Server Monitor Web SSH Terminal ===\x1b[0m");
                term.writeln("Enter host, port, username, password above and click \x1b[1;32mConnect\x1b[0m.\r\n");
            }
        }

        function closeTerminalModal() {
            disconnectWs();
            overlay.classList.add("hidden");
            if (modalBox) modalBox.classList.remove("terminal-fullscreen");
        }

        btnSSH.addEventListener("click", (e) => {
            e.preventDefault();
            openTerminalModal("ssh");
        });

        if (btnConsole) {
            btnConsole.addEventListener("click", (e) => {
                e.preventDefault();
                openTerminalModal("console");
            });
        }

        if (closeBtn) closeBtn.addEventListener("click", closeTerminalModal);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeTerminalModal();
        });

        function initXterm() {
            termBox.innerHTML = "";
            if (typeof Terminal === "undefined") {
                termBox.innerHTML = `<div style="color:#ef4444; padding:20px;">xterm.js library failed to load. Please refresh.</div>`;
                return;
            }

            term = new Terminal({
                cursorBlink: true,
                fontSize: 13,
                fontFamily: "'Menlo', 'Monaco', 'Consolas', 'Courier New', monospace",
                theme: {
                    background: '#000000',
                    foreground: '#f8fafc',
                    cursor: '#10b981'
                }
            });

            if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
                fitAddon = new FitAddon.FitAddon();
                term.loadAddon(fitAddon);
            }

            term.open(termBox);
            if (fitAddon) setTimeout(() => fitAddon.fit(), 100);

            term.onData(data => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "data", data }));
                }
            });

            term.attachCustomKeyEventHandler((arg) => {
                const isCtrlOrCmd = arg.ctrlKey || arg.metaKey;
                const isKeyC = arg.code === 'KeyC' || arg.key === 'c' || arg.key === 'C';
                const isKeyV = arg.code === 'KeyV' || arg.key === 'v' || arg.key === 'V';

                if (isCtrlOrCmd && isKeyC && arg.type === 'keydown') {
                    if (!term.hasSelection()) {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: "data", data: "\x03" }));
                        }
                        return false; // Prevent browser accelerator and send SIGINT (\x03)
                    }
                }

                if (isCtrlOrCmd && isKeyV && arg.type === 'keydown') {
                    if (!term.hasSelection()) {
                        navigator.clipboard.readText().then(text => {
                            if (ws && ws.readyState === WebSocket.OPEN && text) {
                                ws.send(JSON.stringify({ type: "data", data: text }));
                            }
                        }).catch(() => {});
                        return false;
                    }
                }

                return true;
            });

            window.addEventListener("resize", () => {
                if (fitAddon && overlay && !overlay.classList.contains("hidden")) {
                    fitAddon.fit();
                    if (ws && ws.readyState === WebSocket.OPEN && term) {
                        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                    }
                }
            });
        }

        function connectConsoleWs() {
            disconnectWs();

            term.writeln(`\x1b[33mConnecting to Emergency Local Console...\x1b[0m\r\n`);

            const protocol = location.protocol === "https:" ? "wss://" : "ws://";
            const wsUrl = `${protocol}${location.host}/api/console`;

            try {
                ws = new WebSocket(wsUrl);
            } catch (err) {
                term.writeln(`\x1b[31mConsole Connection Error: ${err.message}\x1b[0m`);
                return;
            }

            const currentWs = ws;

            ws.onopen = () => {
                if (ws !== currentWs) return;
                if (fitAddon) fitAddon.fit();
                if (term) {
                    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                }
            };

            ws.onmessage = (event) => {
                if (ws !== currentWs) return;
                term.write(event.data);
            };

            ws.onerror = (event) => {
                if (ws !== currentWs) return;
                term.writeln("\r\n\x1b[31m[Emergency Console Connection Failed]\x1b[0m");
            };

            ws.onclose = () => {
                if (ws !== currentWs) return;
                term.writeln("\r\n\x1b[33m[Emergency Console Closed]\x1b[0m");
                ws = null;
            };
        }

        function connectSshWs() {
            disconnectWs();

            const host = hostInput ? (hostInput.value ? hostInput.value.trim() : "127.0.0.1") : "127.0.0.1";
            const port = portInput ? parseInt(portInput.value, 10) || 22 : 22;
            const username = userInput ? (userInput.value ? userInput.value.trim() : "root") : "root";
            const password = passInput ? passInput.value : "";

            if (!host || !username) {
                alert("Please enter host and username.");
                return;
            }

            term.writeln(`\r\n\x1b[33mConnecting to ${username}@${host}:${port}...\x1b[0m`);

            const protocol = location.protocol === "https:" ? "wss://" : "ws://";
            const wsUrl = `${protocol}${location.host}/api/ssh`;

            try {
                ws = new WebSocket(wsUrl);
            } catch (err) {
                term.writeln(`\x1b[31mWebSocket Connection Error: ${err.message}\x1b[0m`);
                return;
            }

            const currentWs = ws;

            ws.onopen = () => {
                if (ws !== currentWs) return;
                ws.send(JSON.stringify({
                    type: "auth",
                    host,
                    port,
                    username,
                    password
                }));

                if (fitAddon) fitAddon.fit();
                if (term) {
                    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                }

                if (btnConnect) btnConnect.style.display = "none";
                if (btnDisconnect) btnDisconnect.style.display = "inline-block";
            };

            ws.onmessage = (event) => {
                if (ws !== currentWs) return;
                term.write(event.data);
            };

            ws.onerror = (event) => {
                if (ws !== currentWs) return;
                term.writeln("\r\n\x1b[31m[WebSocket Connection Failed]\x1b[0m");
            };

            ws.onclose = () => {
                if (ws !== currentWs) return;
                term.writeln("\r\n\x1b[33m[SSH Connection Closed]\x1b[0m");
                if (btnConnect) btnConnect.style.display = "inline-block";
                if (btnDisconnect) btnDisconnect.style.display = "none";
                ws = null;
            };
        }

        function disconnectWs() {
            if (ws) {
                try {
                    ws.onopen = null;
                    ws.onmessage = null;
                    ws.onerror = null;
                    ws.onclose = null;
                    ws.close();
                } catch(e){}
                ws = null;
            }
            if (btnConnect) btnConnect.style.display = "inline-block";
            if (btnDisconnect) btnDisconnect.style.display = "none";
        }

        if (btnConnect) btnConnect.addEventListener("click", connectSshWs);
        if (btnDisconnect) btnDisconnect.addEventListener("click", disconnectWs);

        if (passInput) {
            passInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") connectSshWs();
            });
        }
    }

    // ─── AdGuard Home DNS Monitor ─────────────────────────────────────────────
    function setupDnsMonitor() {
        const btnOpen = document.getElementById("btnDnsOpen");
        const overlay = document.getElementById("dnsOverlay");
        const btnClose = document.getElementById("closeDns");
        const btnRefresh = document.getElementById("btnRefreshDnsManual");

        if (!btnOpen || !overlay || !btnClose) return;

        let dnsTimer = null;
        let dnsChartInstance = null;

        function openDnsModal() {
            overlay.classList.remove("hidden");
            document.body.style.overflow = "hidden";
            fetchDnsData();
            if (dnsTimer) clearInterval(dnsTimer);
            dnsTimer = setInterval(fetchDnsData, 5000);
        }

        function closeDnsModal() {
            overlay.classList.add("hidden");
            document.body.style.overflow = "";
            if (dnsTimer) {
                clearInterval(dnsTimer);
                dnsTimer = null;
            }
        }

        btnOpen.addEventListener("click", openDnsModal);
        btnClose.addEventListener("click", closeDnsModal);
        if (btnRefresh) {
            btnRefresh.addEventListener("click", () => {
                fetchDnsData();
            });
        }

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeDnsModal();
        });

        async function fetchDnsData() {
            try {
                // Fetch status and stats concurrently
                const [statusRes, statsRes] = await Promise.all([
                    fetch("/api/dns/status").then(r => r.json()).catch(() => ({ available: false })),
                    fetch("/api/dns/stats").then(r => r.json()).catch(() => ({ available: false }))
                ]);

                // Update Status & Version Badges
                const verBadge = document.getElementById("dnsVersionBadge");
                const protBadge = document.getElementById("dnsProtectionBadge");
                if (verBadge) {
                    verBadge.textContent = statusRes.version ? `v${statusRes.version}` : 'v0.107';
                }
                if (protBadge) {
                    if (statusRes.protection_enabled) {
                        protBadge.textContent = "PROTECTION ON";
                        protBadge.style.color = "#4ade80";
                        protBadge.style.background = "rgba(34, 197, 94, 0.15)";
                        protBadge.style.borderColor = "rgba(34, 197, 94, 0.35)";
                    } else {
                        protBadge.textContent = "PROTECTION OFF";
                        protBadge.style.color = "#f43f5e";
                        protBadge.style.background = "rgba(244, 63, 94, 0.15)";
                        protBadge.style.borderColor = "rgba(244, 63, 94, 0.35)";
                    }
                }

                if (!statsRes.available) {
                    const totalEl = document.getElementById("dnsStatTotalQueries");
                    if (totalEl) totalEl.textContent = "Offline";
                    return;
                }

                // Top Cards
                const totalEl = document.getElementById("dnsStatTotalQueries");
                const qpsEl = document.getElementById("dnsStatQps");
                const latEl = document.getElementById("dnsStatAvgLatency");
                const latStatusEl = document.getElementById("dnsStatLatencyStatus");
                const blockedEl = document.getElementById("dnsStatBlockedCount");
                const blockedPctEl = document.getElementById("dnsStatBlockedPct");
                const fastestUpstreamEl = document.getElementById("dnsStatFastestUpstream");
                const fastestLatencyEl = document.getElementById("dnsStatFastestLatency");

                if (totalEl) totalEl.textContent = (statsRes.num_queries || 0).toLocaleString();
                if (qpsEl) qpsEl.textContent = `${statsRes.estimated_qps || 0} QPS`;

                const lat = statsRes.avg_latency_ms || 0;
                if (latEl) latEl.textContent = `${lat} ms`;
                if (latStatusEl) {
                    if (lat <= 25) {
                        latStatusEl.textContent = "Fast";
                        latStatusEl.style.color = "#22c55e";
                        latStatusEl.style.background = "rgba(34, 197, 94, 0.15)";
                    } else if (lat <= 60) {
                        latStatusEl.textContent = "Moderate";
                        latStatusEl.style.color = "#fbbf24";
                        latStatusEl.style.background = "rgba(251, 191, 36, 0.15)";
                    } else {
                        latStatusEl.textContent = "Slow";
                        latStatusEl.style.color = "#f43f5e";
                        latStatusEl.style.background = "rgba(244, 63, 94, 0.15)";
                    }
                }

                if (blockedEl) blockedEl.textContent = (statsRes.num_blocked || 0).toLocaleString();
                if (blockedPctEl) blockedPctEl.textContent = `${statsRes.blocked_percentage || 0}%`;

                // Fastest upstream
                if (statsRes.upstreams && statsRes.upstreams.length > 0) {
                    const sortedByLat = [...statsRes.upstreams].filter(u => u.latency_ms > 0).sort((a, b) => a.latency_ms - b.latency_ms);
                    const fastest = sortedByLat[0] || statsRes.upstreams[0];
                    if (fastestUpstreamEl) fastestUpstreamEl.textContent = fastest.server.replace(':53', '');
                    if (fastestLatencyEl) fastestLatencyEl.textContent = `${fastest.latency_ms} ms`;
                }

                // Render Chart
                renderDnsChart(statsRes.history);

                // Render Upstreams Matrix
                renderDnsUpstreams(statsRes.upstreams || []);

                // Render Top Domains
                renderDnsTopDomains(statsRes.top_domains || []);

                // Render Top Clients
                renderDnsTopClients(statsRes.top_clients || []);

            } catch (err) {
                console.error("DNS stats error:", err);
            }
        }

        function renderDnsChart(history) {
            const canvas = document.getElementById("dnsQueryChart");
            if (!canvas) return;

            const queries = (history && history.queries) ? history.queries : [];
            const blocked = (history && history.blocked) ? history.blocked : [];

            // Generate 24 hourly labels: -23h, -22h, ... Now
            const labels = [];
            for (let i = 23; i >= 0; i--) {
                labels.push(i === 0 ? "Now" : `-${i}h`);
            }

            if (dnsChartInstance) {
                dnsChartInstance.data.labels = labels;
                dnsChartInstance.data.datasets[0].data = queries;
                dnsChartInstance.data.datasets[1].data = blocked;
                dnsChartInstance.update();
            } else {
                const ctx = canvas.getContext("2d");
                const gradientQueries = ctx.createLinearGradient(0, 0, 0, 160);
                gradientQueries.addColorStop(0, "rgba(34, 197, 94, 0.35)");
                gradientQueries.addColorStop(1, "rgba(34, 197, 94, 0.0)");

                const gradientBlocked = ctx.createLinearGradient(0, 0, 0, 160);
                gradientBlocked.addColorStop(0, "rgba(244, 63, 94, 0.35)");
                gradientBlocked.addColorStop(1, "rgba(244, 63, 94, 0.0)");

                dnsChartInstance = new Chart(ctx, {
                    type: "line",
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: "Total Queries",
                                data: queries,
                                borderColor: "#22c55e",
                                backgroundColor: gradientQueries,
                                borderWidth: 2,
                                fill: true,
                                tension: 0.35,
                                pointRadius: 2,
                                pointHoverRadius: 5
                            },
                            {
                                label: "Blocked",
                                data: blocked,
                                borderColor: "#f43f5e",
                                backgroundColor: gradientBlocked,
                                borderWidth: 2,
                                fill: true,
                                tension: 0.35,
                                pointRadius: 2,
                                pointHoverRadius: 5
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            intersect: false,
                            mode: "index"
                        },
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: "#1e2026",
                                borderColor: "#333742",
                                borderWidth: 1,
                                padding: 10,
                                titleColor: "#f1f5f9",
                                bodyColor: "#cbd5e1"
                            }
                        },
                        scales: {
                            x: {
                                grid: { color: "rgba(255, 255, 255, 0.05)" },
                                ticks: { color: "#787f8d", maxTicksLimit: 12, font: { size: 10 } }
                            },
                            y: {
                                grid: { color: "rgba(255, 255, 255, 0.05)" },
                                ticks: { color: "#787f8d", font: { size: 10 } },
                                beginAtZero: true
                            }
                        }
                    }
                });
            }
        }

        function renderDnsUpstreams(upstreams) {
            const container = document.getElementById("dnsUpstreamList");
            if (!container) return;

            if (upstreams.length === 0) {
                container.innerHTML = `<div style="color: #787f8d; font-size: 0.85rem; padding: 8px;">No upstream responses recorded yet.</div>`;
                return;
            }

            container.innerHTML = upstreams.map(u => {
                const srvClean = u.server.replace(':53', '');
                const lat = u.latency_ms || 0;
                let latColor = "#22c55e";
                if (lat > 50) latColor = "#fbbf24";
                if (lat > 150) latColor = "#f43f5e";

                return `
                <div style="background: #1f2127; border: 1px solid #2d313c; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.84rem; font-weight: 600; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${u.server}">
                            ${srvClean}
                        </span>
                        <span style="font-size: 0.8rem; font-weight: 600; color: ${latColor}; background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 4px;">
                            ${lat} ms
                        </span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.76rem; color: #787f8d;">
                        <span>${u.count.toLocaleString()} queries</span>
                        <span>${u.percent}%</span>
                    </div>
                    <div style="height: 4px; background: #2a2d36; border-radius: 2px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(100, Math.max(2, u.percent))}%; background: linear-gradient(90deg, #38bdf8, #22c55e); border-radius: 2px;"></div>
                    </div>
                </div>`;
            }).join('');
        }

        function renderDnsTopDomains(domains) {
            const container = document.getElementById("dnsTopDomainsList");
            if (!container) return;

            if (domains.length === 0) {
                container.innerHTML = `<div style="color: #787f8d; font-size: 0.85rem;">No query data available.</div>`;
                return;
            }

            container.innerHTML = domains.map((d, i) => `
                <div style="background: #1f2127; border: 1px solid #2b2e37; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
                            <span style="font-size: 0.72rem; color: #787f8d; min-width: 16px;">#${i + 1}</span>
                            <span style="font-size: 0.82rem; font-weight: 500; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${d.domain}">
                                ${d.domain}
                            </span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                            <span style="font-size: 0.8rem; font-weight: 600; color: #ffffff;">${d.count.toLocaleString()}</span>
                            <span style="font-size: 0.74rem; color: #fbbf24; min-width: 38px; text-align: right;">${d.percent}%</span>
                        </div>
                    </div>
                    <div style="height: 3px; background: #2a2d36; border-radius: 2px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(100, Math.max(1, d.percent))}%; background: linear-gradient(90deg, #f59e0b, #fbbf24); border-radius: 2px;"></div>
                    </div>
                </div>
            `).join('');
        }

        function renderDnsTopClients(clients) {
            const container = document.getElementById("dnsTopClientsList");
            if (!container) return;

            if (clients.length === 0) {
                container.innerHTML = `<div style="color: #787f8d; font-size: 0.85rem;">No client data available.</div>`;
                return;
            }

            container.innerHTML = clients.map((c, i) => `
                <div style="background: #1f2127; border: 1px solid #2b2e37; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
                            <span style="font-size: 0.72rem; color: #787f8d; min-width: 16px;">#${i + 1}</span>
                            <span style="font-size: 0.82rem; font-weight: 500; color: #f1f5f9; font-family: monospace;">
                                ${c.ip}
                            </span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                            <span style="font-size: 0.8rem; font-weight: 600; color: #ffffff;">${c.count.toLocaleString()}</span>
                            <span style="font-size: 0.74rem; color: #c084fc; min-width: 38px; text-align: right;">${c.percent}%</span>
                        </div>
                    </div>
                    <div style="height: 3px; background: #2a2d36; border-radius: 2px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(100, Math.max(1, c.percent))}%; background: linear-gradient(90deg, #a855f7, #c084fc); border-radius: 2px;"></div>
                    </div>
                </div>
            `).join('');
        }
    }

    function init() {
        injectSVGGradients();
        setupThemeToggle();
        initCharts();
        setupRangeButtons();
        setupFullscreenButtons();
        setupPayloadDropdown();
        setupBenchmark();
        setupSettings();
        setupVirtualBrowser();
        setupV2rayMonitor();
        setupSelfUpdate();
        setupSpeedTest();
        setupTelegramAlerts();
        setupWebSshTerminal();
        setupDnsMonitor();

        setupExtendedFeatures();
        // Fetch interfaces first, then initial data + start timers
        fetchInterfaces().then(() => {
            fetchCurrent();
            fetchMetrics().then(() => {
                setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
            });

            // Apply chart colors for current theme
            setTimeout(updateChartColors, 100);

            // Start auto-refresh AFTER interfaces are loaded
            startAutoRefresh();
        }).catch(() => {
            // Even if interfaces fail, still start the dashboard
            fetchCurrent();
            fetchMetrics().then(() => {
                setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
            });
            setTimeout(updateChartColors, 100);
            startAutoRefresh();
        });
    }

    // Wait for DOM and Chart.js
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
