const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// This tells the code to grab the link you saved in Render's "Environment" tab
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LOYVERSE_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

app.post('/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK'); 

    try {
        // Asks Loyverse for the specific details of this adjustment
        const response = await axios.get(`https://api.loyverse.com/v1.0/inventory/adjustments/${event.entity_id}`, {
            headers: { 'Authorization': `Bearer ${LOYVERSE_TOKEN}` }
        });

        const details = response.data;
        const item = details.stores[0]?.line_items[0]; 
        
        // Formats the pretty message for your phone
        const message = {
            content: `🚨 **Stock Adjustment Detected** 🚨\n` +
                     `📦 **Item:** ${item ? item.variant_name : 'Unknown Item'}\n` +
                     `🔢 **Change:** ${item ? item.stock_delta : '0'}\n` +
                     `👤 **Reason:** ${details.reason || 'Not specified'}`
        };

        // Sends the alert to Discord
        await axios.post(DISCORD_WEBHOOK_URL, message);

    } catch (error) {
        console.error("Error fetching details:", error.response ? error.response.data : error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Smart Bridge Active on port ${PORT}`));
