/**
 * stats.js
 * Visualizes waste data using Chart.js.
 */

let wasteChartInstance = null;

async function renderStats(retryCount = 0) {
    console.log("Rendering Stats Page...");

    // UI Elements
    const rangeSelect = document.getElementById('statsDateRange');
    const loadingEl = document.getElementById('statsLoading');
    const emptyEl = document.getElementById('statsEmpty');
    const contentEl = document.getElementById('statsContent');
    const casesEl = document.getElementById('statValuesCases');
    const costEl = document.getElementById('statValuesCost');
    const listBody = document.getElementById('wasteListBody');

    if (!rangeSelect || !loadingEl || !emptyEl || !contentEl) {
        console.warn("Stats UI elements not found (yet).");
        return;
    }

    // Reset UI
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    contentEl.style.display = 'none';
    listBody.innerHTML = '';
    casesEl.innerText = '0';
    costEl.innerText = '$0.00';

    if (wasteChartInstance) {
        wasteChartInstance.destroy();
        wasteChartInstance = null;
    }

    try {
        // 1. Determine Date Range
        const range = rangeSelect.value || '30';
        const now = new Date();
        let startDate = new Date(); // default

        if (range === '30') {
            startDate.setDate(now.getDate() - 30);
        } else if (range === 'YTD') {
            startDate = new Date(now.getFullYear(), 0, 1); 
        } else if (range === 'ALL') {
             startDate = new Date(2020, 0, 1);
        }

        // Format
        const yyyy = startDate.getFullYear();
        const mm = String(startDate.getMonth() + 1).padStart(2, '0');
        const dd = String(startDate.getDate()).padStart(2, '0');
        const startDateStr = `${yyyy}-${mm}-${dd}`;

        console.log(`[Stats] Fetching from ${startDateStr} (${range})`);

        // 2. Fetch Data
        if (!window.fetchWasteReports) {
            if (retryCount < 10) {
                console.warn(`[Stats] fetchWasteReports not ready (attempt ${retryCount + 1}).`);
                setTimeout(() => renderStats(retryCount + 1), 500);
            } else {
                console.error("[Stats] fetchWasteReports failed to initialize.");
                alert("Error: Firebase services could not be loaded. Check your connection or ad blocker.");
            }
            return;
        }

        let reports = [];
        try {
             reports = await window.fetchWasteReports(startDateStr);
        } catch (e) {
             console.error("[Stats] Fetch failed", e);
        }

        if (!reports || reports.length === 0) {
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'block';
            return;
        }

        // 3. Aggregate Data
        let totalCases = 0;
        let totalCost = 0;
        const itemAggregates = {};

        reports.forEach(report => {
            if (!report.items) return;

            report.items.forEach(item => {
                // Ensure we have a valid key for pricing
                let key = item.matchedKey;
                
                // Fallback for older reports or missing keys
                if (!key && item.name) {
                    key = window.findMatchingItemKey ? 
                          window.findMatchingItemKey(item.name, AppState.maxInventory) : null;
                }

                const qty = parseFloat(item.diff) || 0;
                // Price lookup
                let price = 0;
                if (key && AppState.unitPrices && AppState.unitPrices[key]) {
                    price = AppState.unitPrices[key];
                }

                const cost = qty * price;

                totalCases += qty;
                totalCost += cost;

                // Group by Key (preferred) or Name
                const displayKey = key || item.name || "Unknown";
                
                if (!itemAggregates[displayKey]) {
                    itemAggregates[displayKey] = { 
                        name: item.name || displayKey, // Keep original name if possible
                        qty: 0, 
                        cost: 0 
                    };
                }
                itemAggregates[displayKey].qty += qty;
                itemAggregates[displayKey].cost += cost;
            });
        });

        // 4. Update Summary Cards
        casesEl.innerText = totalCases.toFixed(1);
        casesEl.innerText = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(totalCases);
        costEl.innerText = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totalCost);

        // 5. Sort Items
        const sortedItems = Object.values(itemAggregates)
            .sort((a, b) => b.cost - a.cost); // Sort by cost descending

        if (sortedItems.length === 0) {
            loadingEl.style.display = 'none';
            emptyEl.style.display = 'block';
            return;
        }

        // 6. Render List
        sortedItems.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.name}</td>
                <td style="padding: 8px; text-align: right; border-bottom: 1px solid #eee;">${item.qty.toFixed(2)}</td>
                <td style="padding: 8px; text-align: right; border-bottom: 1px solid #eee;">$${item.cost.toFixed(2)}</td>
            `;
            listBody.appendChild(tr);
        });

        // 7. Render Chart
        if (typeof Chart === 'undefined') {
            console.error("Chart.js not loaded");
            return;
        }

        const ctx = document.getElementById('wasteChart').getContext('2d');
        
        // Prepare Chart Data (Top 6 + Others)
        const topN = 6;
        const chartLabels = [];
        const chartValues = [];
        const chartColors = [
            '#e53935', '#fb8c00', '#fdd835', '#43a047', 
            '#1e88e5', '#8e24aa', '#c0ca33', '#6d4c41'
        ];
        
        let otherCost = 0;

        sortedItems.forEach((item, index) => {
            if (index < topN) {
                chartLabels.push(item.name);
                chartValues.push(item.cost);
            } else {
                otherCost += item.cost;
            }
        });

        if (otherCost > 0) {
            chartLabels.push('Other');
            chartValues.push(otherCost);
        }

        wasteChartInstance = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: chartLabels,
                datasets: [{
                    data: chartValues,
                    backgroundColor: chartColors.slice(0, chartLabels.length),
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { boxWidth: 12, font: { size: 10 } }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });

        loadingEl.style.display = 'none';
        contentEl.style.display = 'block';

    } catch (err) {
        console.error("Error rendering stats:", err);
        loadingEl.innerText = "Error loading data.";
    }
}
