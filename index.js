const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

// Helper to wait a moment for the Loyverse API to sync
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK');

    try {
        await wait(2000); // Wait 2 seconds for Loyverse to finish updating

        if (event.type === 'inventory_levels.update' && event.inventory_levels) {
            for (const inv of event.inventory_levels) {
                const itemRes = await axios.get(`https://api.loyverse.com/v1.0/variants/${inv.variant_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });
                
                // Extremely robust name check
                const itemName = itemRes.data.variant_name || itemRes.data.item_name || itemRes.data.sku || "Unknown Product";

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `📦 **Stock Level Updated**\n` +
                             `🔹 **Product:** ${itemName}\n` +
                             `🏁 **New Total:** ${inv.in_stock}`
                });
            }
        } 
        else if (event.entity_id || event.id) {
            const adjId = event.entity_id || event.id;
            const adjRes = await axios.get(`https://api.loyverse.com/v1.0/inventory/adjustments/${adjId}`, {
                headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
            });
            
            const data = adjRes.data;
            const item = data.stores[0]?.line_items[0];
            
            if (item) {
                const change = parseFloat(item.stock_delta);
                const result = parseFloat(item.post_stock_level);
                const former = result - change;

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `✅ **Stock Adjustment**\n` +
                             `👤 **User:** ${data.employee_name || 'Admin'}\n` +
                             `📦 **Product:** ${item.variant_name || item.item_name || 'Product Name Missing'}\n` +
                             `🔢 **Former Stock:** ${former}\n` +
                             `🔄 **Change:** ${change > 0 ? '+' + change : change}\n` +
                             `🏁 **Resulting Stock:** ${result}`
                });
            }
        }
    } catch (error) {
        console.error("Fetch Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active`));
