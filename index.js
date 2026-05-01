const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

app.post('/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK');

    try {
        // Handle Stock Adjustments (Best for showing Former vs Result)
        if (event.entity_id || event.id) {
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
                    content: `✅ **Stock Update Success**\n` +
                             `👤 **User:** ${data.employee_name || 'Admin'}\n` +
                             `📦 **Product:** ${item.variant_name || item.item_name}\n` +
                             `🔢 **Former Stock:** ${former}\n` +
                             `🔄 **Change:** ${change > 0 ? '+' + change : change}\n` +
                             `🏁 **Resulting Stock:** ${result}`
                });
            }
        } 
        // Handle Simple Level Updates
        else if (event.type === 'inventory_levels.update' && event.inventory_levels) {
            for (const inv of event.inventory_levels) {
                const itemRes = await axios.get(`https://api.loyverse.com/v1.0/variants/${inv.variant_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });
                
                const itemName = itemRes.data.variant_name || itemRes.data.item_name;

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `📦 **Quick Stock Update**\n` +
                             `🔹 **Product:** ${itemName}\n` +
                             `🏁 **New Total:** ${inv.in_stock}`
                });
            }
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active`));
