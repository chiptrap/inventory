/**
 * calculator.js
 * CSV parsing, order verification workflow, and results rendering.
 */

// --- SORT STATE ---
let _lastProcessedData = [];
let _currentSortColumn = null;
let _currentSortDirection = null; // 'asc' or 'desc'

// --- VERIFICATION FLOW ---

function initiateVerification() {
    const suppressed = localStorage.getItem('suppressInventoryWarning');
    if (suppressed === 'true') {
        processFile();
    } else {
        openModal('warningModal');
    }
}

function confirmVerification() {
    const checkbox = document.getElementById('dontShowAgain');
    if (checkbox.checked) {
        localStorage.setItem('suppressInventoryWarning', 'true');
    }
    closeWarningModal();
    processFile();
}

// --- FILE PROCESSING ---

function processFile() {
    const fileInput = document.getElementById('csvFile');
    const errorMsg = document.getElementById('error-msg');

    if (!fileInput.files.length) {
        errorMsg.innerText = "Please upload a CSV file first.";
        errorMsg.style.display = 'block';
        return;
    }

    errorMsg.style.display = 'none';
    const file = fileInput.files[0];

    // Upload raw CSV to Firebase Storage (non-blocking)
    if (window.uploadCSVToFirebase) {
        window.uploadCSVToFirebase(file, 'inventory-order')
            .then(function (url) {
                console.log('[Firebase] Inventory CSV uploaded:', url);
                showToast('CSV backed up to cloud.');
            })
            .catch(function (err) {
                console.warn('[Firebase] Storage upload failed:', err);
            });
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = parseCSV(e.target.result);
            calculateAndRender(data);

            // Save parsed results to Firestore (non-blocking)
            // Use _lastProcessedData which has the calculated diff & variance
            if (window.saveToFirestore && _lastProcessedData && _lastProcessedData.length > 0) {
                // 1. Update running variance totals
                if (window.updateVarianceTotals) {
                    window.updateVarianceTotals(_lastProcessedData);
                }

                // 2. Save individual report (only name & variance as requested)
                const shipmentVal = document.getElementById('selectedShipmentDateValue').value;
                const payload = {
                    fileName: file.name,
                    currentDate: AppState.globalCurrentDate.toISOString(),
                    shipmentDate: shipmentVal,
                    itemCount: _lastProcessedData.length,
                    items: _lastProcessedData.map(function (row) {
                        return {
                            name: row.name,
                            diff: row.diff
                        };
                    })
                };
                window.saveToFirestore('inventory-results', payload)
                    .then(function (id) {
                        console.log('[Firebase] Inventory results saved, doc:', id);
                    })
                    .catch(function (err) {
                        console.warn('[Firebase] Firestore save failed:', err);
                    });
            }
        } catch (err) {
            errorMsg.innerText = "Error processing CSV: " + err.message;
            errorMsg.style.display = 'block';
        }
    };
    reader.readAsText(file);
}

// --- CSV PARSING ---

function parseCSV(csvText) {
    const lines = csvText.split(/\r\n|\n/);
    const result = [];

    lines.forEach(line => {
        if (!line.trim()) return;

        const cols = parseCSVLine(line);
        if (cols.length < 8) return;
        if (isNaN(parseFloat(cols[3])) && isNaN(parseFloat(cols[7]))) return;

        result.push({
            name: cols[2],
            onHand: parseFloat(cols[3]) || 0,
            inTransit: parseFloat(cols[4]) || 0,
            amountToOrder: parseFloat(cols[7]) || 0
        });
    });

    return result;
}

/**
 * Parse a single CSV line, respecting quoted fields.
 */
function parseCSVLine(line) {
    const cols = [];
    let inQuote = false;
    let token = '';

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            cols.push(token.trim().replace(/^"|"$/g, ''));
            token = '';
        } else {
            token += char;
        }
    }
    cols.push(token.trim().replace(/^"|"$/g, ''));
    return cols;
}

// --- DYNAMIC USAGE CALCULATION ---

/**
 * Calculate total projected usage for an item over a date range.
 * Iterates each day from startDate (inclusive) to endDate (exclusive),
 * using that day's sales projection × the item's usage-per-thousand rate.
 * Returns 0 if the item has no UPT rate (caller should use fallback).
 */
function calculateUsageForPeriod(itemKey, startDate, endDate) {
    const upt = AppState.usagePerThousand[itemKey];
    if (!upt) return 0;

    let totalUsage = 0;
    const day = new Date(startDate);

    while (day < endDate) {
        const dayName = day.toLocaleDateString('en-US', { weekday: 'long' });
        const projectedSales = AppState.salesProjections[dayName] || 0;
        totalUsage += (projectedSales / 1000) * upt;
        day.setDate(day.getDate() + 1);
    }

    return totalUsage;
}

// --- CALCULATION & RENDERING ---

function calculateAndRender(data) {
    const current = new Date(AppState.globalCurrentDate);
    current.setHours(0, 0, 0, 0);

    const shipmentVal = document.getElementById('selectedShipmentDateValue').value;
    const shipment = new Date(shipmentVal);
    shipment.setHours(0, 0, 0, 0);

    const errorMsg = document.getElementById('error-msg');
    const daysUntilShipment = Math.ceil(Math.abs(shipment - current) / (1000 * 60 * 60 * 24));

    const tbody = document.querySelector('#resultsTable tbody');
    tbody.innerHTML = '';

    let overOrderCount = 0;

    const processedData = data
        .map(row => processRow(row, current, shipment, daysUntilShipment))
        .filter(item => item !== null);

    if (processedData.length === 0) {
        errorMsg.innerText = "No matching items found. Please check item names in Settings.";
        errorMsg.style.display = 'block';
        document.getElementById('resultsCard').style.display = 'none';
        return;
    }

    // Store for re-sorting later
    _lastProcessedData = processedData;
    _currentSortColumn = null;
    _currentSortDirection = null;

    // Default sort: over-orders first, then under-orders, then OK — alphabetical within each group
    processedData.sort((a, b) => {
        const priorityA = a.isOver ? 0 : a.isUnder ? 1 : 2;
        const priorityB = b.isOver ? 0 : b.isUnder ? 1 : 2;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.name.localeCompare(b.name);
    });

    // Clear any active sort indicators
    updateSortIndicators(null, null);

    let underOrderCount = 0;

    processedData.forEach(item => {
        if (item.isOver) overOrderCount++;
        if (item.isUnder) underOrderCount++;

        const tr = document.createElement('tr');
        if (item.isOver) tr.classList.add('over-order');
        else if (item.isUnder) tr.classList.add('under-order');

        const statusColor = item.isOver ? '#d32f2f' : item.isUnder ? '#b8860b' : '#2e7d32';
        const statusText = item.isOver ? 'OVER ORDER' : item.isUnder ? 'UNDER ORDER' : 'OK';

        tr.innerHTML = `
            <td><strong>${item.name}</strong></td>
            <td>${item.onHand.toFixed(2)}</td>
            <td>${item.inTransit.toFixed(2)}</td>
            <td>${item.amountToOrder.toFixed(2)}</td>
            <td>${item.estimatedInventory.toFixed(2)}</td>
            <td>${item.diff.toFixed(2)}</td>
            <td><span style="font-weight:800; color:${statusColor}">
                ${statusText}
            </span></td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('resultsCard').style.display = 'block';

    const dayName = shipment.toLocaleDateString('en-US', { weekday: 'long' });
    const issues = overOrderCount + underOrderCount;
    document.getElementById('summaryText').innerText =
        `${dayName} Shipment • ${issues} Issue${issues !== 1 ? 's' : ''} Found`;

    document.getElementById('resultsCard').scrollIntoView({ behavior: 'smooth' });
}

/**
 * Process a single CSV row against inventory limits.
 * Uses dynamic per-day usage (sales projections × UPT rates).
 * Falls back to flat consumptionDict rate if item has no UPT data.
 * Returns null if the item should be skipped.
 */
function processRow(row, currentDate, shipmentDate, daysUntilShipment) {
    // Exclude specific double entry
    if (row.name.includes("Corn w/ Poblano Mix, 20lb")) return null;

    const matchedKey = findMatchingItemKey(row.name, AppState.maxInventory);
    if (!matchedKey) return null;

    const maxInv = AppState.maxInventory[matchedKey];

    // Dynamic usage: sum each day's (projected sales / 1000) × UPT rate
    let usageUntilShipment = calculateUsageForPeriod(matchedKey, currentDate, shipmentDate);

    // Fallback: if no UPT rate exists, use flat daily consumption
    if (usageUntilShipment === 0) {
        const consumption = AppState.consumptionDict[matchedKey] || 1;
        usageUntilShipment = consumption * daysUntilShipment;
    }

    // Usage can only draw from what's on hand before shipment arrives
    const availableBeforeShipment = Math.max(0, row.onHand + row.inTransit);
    usageUntilShipment = Math.min(usageUntilShipment, availableBeforeShipment);

    // Estimated inventory = what's left after usage + what arrives with the order
    const estimatedInventory = (availableBeforeShipment - usageUntilShipment) + row.amountToOrder;

    let diff = maxInv - estimatedInventory;
    if (row.amountToOrder === 0 && diff < 0) diff = 0;

    const isOver = diff < -0.5;
    const isUnder = !isOver && estimatedInventory < 1;

    return {
        ...row,
        matchedKey,
        estimatedInventory,
        diff,
        isOver,
        isUnder
    };
}

// --- TABLE SORTING ---

function sortResultsTable(column) {
    if (_lastProcessedData.length === 0) return;

    // Toggle direction: if same column, flip; otherwise start ascending
    if (_currentSortColumn === column) {
        _currentSortDirection = _currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        _currentSortColumn = column;
        _currentSortDirection = 'asc';
    }

    const dir = _currentSortDirection === 'asc' ? 1 : -1;

    _lastProcessedData.sort((a, b) => {
        const valA = a[column];
        const valB = b[column];

        // Booleans (Status column)
        if (typeof valA === 'boolean') {
            return (valA === valB) ? 0 : (valA ? -dir : dir);
        }
        // Strings
        if (typeof valA === 'string') {
            return dir * valA.localeCompare(valB);
        }
        // Numbers
        return dir * (valA - valB);
    });

    // Re-render rows
    const tbody = document.querySelector('#resultsTable tbody');
    tbody.innerHTML = '';

    _lastProcessedData.forEach(item => {
        const tr = document.createElement('tr');
        if (item.isOver) tr.classList.add('over-order');
        else if (item.isUnder) tr.classList.add('under-order');

        const statusColor = item.isOver ? '#d32f2f' : item.isUnder ? '#b8860b' : '#2e7d32';
        const statusText = item.isOver ? 'OVER ORDER' : item.isUnder ? 'UNDER ORDER' : 'OK';

        tr.innerHTML = `
            <td><strong>${item.name}</strong></td>
            <td>${item.onHand.toFixed(2)}</td>
            <td>${item.inTransit.toFixed(2)}</td>
            <td>${item.amountToOrder.toFixed(2)}</td>
            <td>${item.estimatedInventory.toFixed(2)}</td>
            <td>${item.diff.toFixed(2)}</td>
            <td><span style="font-weight:800; color:${statusColor}">
                ${statusText}
            </span></td>
        `;
        tbody.appendChild(tr);
    });

    updateSortIndicators(column, _currentSortDirection);
}

function updateSortIndicators(activeColumn, direction) {
    document.querySelectorAll('#resultsTable th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (activeColumn && th.dataset.sort === activeColumn) {
            th.classList.add(direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

/**
 * Fuzzy-match a CSV item name to an inventory key.
 */
function findMatchingItemKey(csvName, inventory) {
    const lowerName = csvName.toLowerCase();

    return Object.keys(inventory).find(k => {
        const lowerKey = k.toLowerCase();
        if (lowerName.includes(lowerKey)) return true;
        if (lowerKey === 'black beans' && lowerName.includes('black') && lowerName.includes('beans')) return true;
        if (lowerKey === 'pinto beans' && lowerName.includes('pinto') && lowerName.includes('beans')) return true;
        return false;
    });
}
