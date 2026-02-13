/**
 * lto.js
 * Limited Time Offer (LTO) selection management.
 * Persists selected LTO items to localStorage.
 */

const LTO_OPTIONS = [
    { id: 'al-pastor-chicken', label: 'Al Pastor Chicken' }
    // Future LTO items go here
];

const LTO_STORAGE_KEY = 'ltoSelections';

function getLtoSelections() {
    return JSON.parse(localStorage.getItem(LTO_STORAGE_KEY)) || {};
}

function saveLtoSelections(selections) {
    localStorage.setItem(LTO_STORAGE_KEY, JSON.stringify(selections));
}

function toggleLtoItem(id) {
    const selections = getLtoSelections();
    selections[id] = !selections[id];
    saveLtoSelections(selections);
    renderLtoTiles();
}

function renderLtoTiles() {
    const container = document.getElementById('ltoTilesGrid');
    if (!container) return;
    const selections = getLtoSelections();

    container.innerHTML = LTO_OPTIONS.map(item => {
        const isActive = !!selections[item.id];
        return `
            <div class="lto-tile ${isActive ? 'active' : ''}" onclick="toggleLtoItem('${item.id}')">
                <div class="lto-tile-label">${item.label}</div>
            </div>
        `;
    }).join('');
}
