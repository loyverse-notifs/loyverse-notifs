const express = require('express');
const app = express();
app.use(express.json());

// This is the part that catches the Loyverse notification
app.post('/webhook', (req, res) => {
    const data = req.body;
    
    // This prints the info to your Render Logs
    console.log("--- STOCK ADJUSTMENT DETECTED ---");
    console.log("Item Name:", data.item_name || "Unknown Item");
    console.log("Adjustment:", data.stock_delta || "0");
    console.log("Changed By:", data.employee_name || "Unknown Person");
    console.log("---------------------------------");

    res.status(200).send('Received');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
