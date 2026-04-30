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

    // This part finds the ID even if Loyverse moves it around
    const adjustmentId = event.entity_id || event.id;

    if (!adjustmentId) {
        console.log("No ID found in this event.");
        return;
    }

    try {
        const response = await axios.get(`https://api.loyverse.com/v1.0/inventory/adjustments/${adjustmentId}`, {
            headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
        });

        const details = response.data;
        const item = details.stores[0]?.line_items[0]; 
        
        const message = {
            content: `🚨 **Stock Adjustment Detected** 🚨\n` +
                     `📦 **Item:** ${item ? item.variant_name : 'Unknown Item'}\n` +
                     `🔢 **Change:** ${item ? item.stock_delta : '0'}\n` +
                     `👤 **Reason:** ${details.reason || 'Not specified'}`
        };

        await axios.post(DISCORD_WEBHOOK_URL, message);

    } catch (error) {
        console.error("Error fetching details:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active on port ${PORT}`));
