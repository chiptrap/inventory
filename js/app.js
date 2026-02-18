/**
 * app.js
 * Application entry point — wires up DOMContentLoaded initialization.
 */

document.addEventListener('DOMContentLoaded', async () => {
    await hydrateFromFirestore();
    initDates();
    applyProjectedUsage(false);
    renderSettings();
    renderUsageSettings();
    renderProjections();
    renderLtoTiles();
});
