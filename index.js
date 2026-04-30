const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// PASTE YOUR DISCORD WEBHOOK URL BETWEEN THE QUOTES BELOW
const DISCORD_WEBHOOK_URL = https://discord.com/api/webhooks/1499385400823644180/iYnVSKX-7QnlqrL-_SiBobfNcOGhOhzgObiIOpiNFQA90_ueNNIzHzqk0fpBhzAQGtOs;

app.post('/webhook', async (req, res) => {
    const data = req.body;
    
    // This organizes the info for your Discord message
    const message = {
        content: `🚨 **Stock Adjustment Detected** 🚨\n` +
                 `📦 **Item:** ${data.item_name || 'Unknown Item'}\n` +
                 `🔢 **Change:** ${data.stock_delta || '0'}\n` +
                 `👤 **Person:** ${data.employee_name || 'Unknown Employee'}`
    };

    try {
        await axios.post(DISCORD_WEBHOOK_URL, message);
        console.log("Alert sent to Discord!");
    } catch (error) {
        console.error("Discord Error:", error);
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Active on port ${PORT}`));
