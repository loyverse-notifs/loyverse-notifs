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
        if (event.type === 'inventory_levels.update' && event.inventory_levels) {
            for (const inv of event.inventory_levels) {
                // 1. Fetch exact product/variant name
                const itemRes = await axios.get(`https://api.loyverse.com/v1.0/variants/${inv.variant_id}`, {
                    headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
                });
                
                const itemName = itemRes.data.variant_name || itemRes.data.item_name || "Unknown Product";
                
                // 2. Calculate the change (Loyverse sends 'in_stock' as the NEW total)
                // Note: To show "From X to Y", we show the final state detected.
                const newStock = inv.in_stock;

                await axios.post(DISCORD_WEBHOOK_URL, {
                    content: `📝 **Stock Change Recorded**\n` +
                             `👤 **User:** System/Admin\n` +
                             `📦 **Product:** ${itemName}\n` +
                             `📊 **Stock Update:** Final level is now **${newStock}**`
                });
            }
        } 
        else if (event.entity_id) {
            // Handle formal Adjustments (these usually have User info)
            const adjRes = await axios.get(`https://api.loyverse.com/v1.0/inventory/adjustments/${event.entity_id}`, {
                headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
            });
            
            const data = adjRes.data;
            const item = data.stores[0]?.line_items[0];
            
            await axios.post(DISCORD_WEBHOOK_URL, {
                content: `🚨 **Manual Adjustment**\n` +
                         `👤 **User:** ${data.employee_name || 'Admin'}\n` +
                         `📦 **Product:** ${item ? item.variant_name : 'Unknown'}\n` +
                         `📉 **Change:** Adjusted by ${item ? item.stock_delta : '0'}`
            });
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active`));
