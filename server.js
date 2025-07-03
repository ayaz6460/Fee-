require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const QRCode = require('qrcode');
const path = require("path");
const qr = require('qrcode');

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Get user dues by roll number
app.get('/api/get-dues/:rollNumber', async (req, res) => {
    const { rollNumber } = req.params;

    try {
        const { data, error } = await supabase
            .from('students')
            .select('name, roll_number, college_fees, transport_fees, pending_fees')
            .eq('roll_number', rollNumber)
            .single();

        if (error || !data) throw new Error("Student not found");
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Initiate payment with Cashfree (Production URL)
app.post('/api/pay', async (req, res) => {
    const { rollNumber, amount } = req.body;

    try {
        const orderId = `ORDER_${Date.now()}`;
        const cashfreeResponse = await axios.post(
            'https://api.cashfree.com/pg/orders', // PRODUCTION URL
            {
                order_id: orderId,
                order_amount: amount,
                order_currency: 'INR',
                customer_details: {
                    customer_id: rollNumber,
                    customer_email: "student@example.com",
                    customer_phone: "9999999999"
                },
                order_meta: {
                    return_url: `https://yourproductionurl.com/payment-success.html?order_id=${orderId}&rollNumber=${rollNumber}&amount=${amount}`
                }
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-client-id": process.env.APP_ID,  // Use production App ID
                    "x-client-secret": process.env.CASHFREE_SECRET_KEY, // Use production Secret Key
                    "x-api-version": "2021-05-21",
                },
            }
        );

        res.json({ paymentLink: cashfreeResponse.data.payment_link, orderId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update dues after payment
app.post('/api/update-dues', async (req, res) => {
    const { rollNumber, amount } = req.body;

    try {
        const { data, error } = await supabase
            .from('students')
            .select('pending_fees')
            .eq('roll_number', rollNumber)
            .single();

        if (error || !data) throw new Error("Student not found");

        const newPendingFees = Math.max(0, data.pending_fees - amount);

        await supabase
            .from('students')
            .update({ pending_fees: newPendingFees })
            .eq('roll_number', rollNumber);

        res.json({ message: "Payment successful, dues updated." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate receipt API
const receiptsDir = path.join(__dirname, 'receipts');
if (!fs.existsSync(receiptsDir)) {
    fs.mkdirSync(receiptsDir);
}
app.get('/api/generate-receipt/:orderId/:rollNumber/:amount', async (req, res) => {
    const { orderId, rollNumber, amount } = req.params;
    const amountPaid = parseFloat(amount); // Convert to number

    try {
        // Fetch student details
        const { data, error } = await supabase
            .from('students')
            .select('name, roll_number, college_fees, transport_fees, pending_fees')
            .eq('roll_number', rollNumber)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: "Student record not found!" });
        }

        const { name, college_fees, transport_fees, pending_fees } = data;

        // Correct pending fees before payment
        const pendingFeesBeforePayment = pending_fees; // Fetching from database
        const dueAmount = Math.max(0, pendingFeesBeforePayment - amountPaid); // Ensure non-negative

        // Generate QR Code containing order ID
        const qrCodePath = path.join(receiptsDir, `qr_${orderId}.png`);
        await qr.toFile(qrCodePath, orderId);

        // Create PDF document
        const pdfPath = path.join(receiptsDir, `Receipt_${orderId}.pdf`);
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        // PDF Content
        doc.fontSize(18).text("Clg of engg", { align: 'center' });
        doc.moveDown();
        doc.fontSize(14).text(`Payment Receipt`, { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(`Name: ${name}`);
        doc.text(`Roll Number: ${rollNumber}`);
        doc.text(`Reference ID: ${orderId}`);
        doc.moveDown();
        doc.text(`College Fees: ${college_fees}`);
        doc.text(`Transport Fees: ${transport_fees}`);
        doc.moveDown();
        doc.text(`Pending Fees Before Payment: ${pendingFeesBeforePayment}`);
        doc.text(`Amount Paid: ${amountPaid}`);
        doc.text(`Updated Pending Fees (Due): ${dueAmount}`);
        doc.moveDown();

        // Add QR Code
        doc.image(qrCodePath, { width: 100, align: 'center' });
        doc.text(`Scan to verify payment: ${orderId}`, { align: 'center' });

        doc.end();

        // Send PDF after stream ends
        stream.on('finish', () => {
            res.download(pdfPath, `Receipt_${orderId}.pdf`, (err) => {
                if (err) {
                    res.status(500).json({ error: "Failed to generate receipt." });
                }
                // Cleanup files
                fs.unlinkSync(pdfPath);
                fs.unlinkSync(qrCodePath);
            });
        });

    } catch (err) {
        console.error("Error generating receipt:", err);
        res.status(500).json({ error: err.message });
    }
});
const path = require("path");

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

