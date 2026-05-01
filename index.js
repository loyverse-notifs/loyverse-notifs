const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

app.post('/webhook', async (req, res) => {
    const event = req.body;
    console.log("Event Received:", JSON.stringify(event));
    res.status(200).send('OK');

    try {
        if (event.type === 'inventory_levels.update' && event.inventory_levels) {
            for (const inv of event.inventory_levels) {
                // Fetch variant details to get the name
                const itemRes = await axios.get(`https://api.loyverse.com/v1.0/variants/${inv.variant_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });
                
                // Try different ways to find the name
                const itemName = itemRes.data.variant_name || itemRes.data.item_name || "Unknown Product";

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `📦 **Stock Level Updated**\n` +
                             `🔹 **Item:** ${itemName}\n` +
                             `📈 **Current Stock:** ${inv.in_stock}`
                });
            }
        } 
        else if (event.entity_id || event.id) {
            const adjId = event.entity_id || event.id;
            const response = await axios.get(`https://api.loyverse.com/v1.0/inventory/adjustments/${adjId}`, {
                headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
            });
            const item = response.data.stores[0]?.line_items[0];
            
            await axios.post(DISCORD_WEBHOOK_URL, {
                content: `🚨 **Adjustment Detected**\n` +
                         `📦 **Item:** ${item ? (item.variant_name || item.item_name) : 'Unknown'}\n` +
                         `🔢 **Change:** ${item ? item.stock_delta : '0'}`
            });
        }
    } catch (error) {
        console.error("Error details:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active on port ${PORT}`));
