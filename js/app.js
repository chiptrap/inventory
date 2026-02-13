/**
 * app.js
 * Application entry point — wires up DOMContentLoaded initialization.
 */

document.addEventListener('DOMContentLoaded', () => {
    initDates();
    applyProjectedUsage();
    renderSettings();
    renderUsageSettings();
    renderProjections();
    renderLtoTiles();
});
