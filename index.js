const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK');

    try {
        await wait(2000); 

        // 1. If it's a formal Stock Adjustment (Shows User + Math)
        if (event.entity_id || (event.type && event.type.includes('adjustment'))) {
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
                    content: `✅ **Detailed Stock Adjustment**\n` +
                             `👤 **User:** ${data.employee_name || 'Admin'}\n` +
                             `📦 **Product:** ${item.variant_name || item.item_name}\n` +
                             `🔢 **Former Stock:** ${former}\n` +
                             `🔄 **Change:** ${change > 0 ? '+' + change : change}\n` +
                             `🏁 **Resulting Stock:** ${result}`
                });
            }
        } 
        // 2. If it's a Quick Level Update (The "11631" type)
        else if (event.type === 'inventory_levels.update') {
            for (const inv of event.inventory_levels) {
                // Fetch the Variant AND the Item to get the full name
                const varRes = await axios.get(`https://api.loyverse.com/v1.0/variants/${inv.variant_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });
                
                const variant = varRes.data;
                // Get the parent item name if variant name is empty
                const itemRes = await axios.get(`https://api.loyverse.com/v1.0/items/${variant.item_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });

                const realName = variant.variant_name || itemRes.data.item_name || "Unknown Product";

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `📦 **Quick Stock Update**\n` +
                             `🔹 **Product:** ${realName}\n` +
                             `🏁 **New Total:** ${inv.in_stock}\n` +
                             `⚠️ *Note: Use "Stock Adjustment" in Loyverse to see User name.*`
                });
            }
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active`));
