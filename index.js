const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const csv = require("csv-writer");
const XLSX = require("xlsx");
const axios = require("axios");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { Parser } = require('json2csv');
const submissionQueue = [];
let activeSubmissions = 0;

const app = express();
const PORT = process.env.PORT || 5000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const MAX_CONCURRENT_SUBMISSIONS = 25;


// ✅ Middleware
app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
//app.use(cors({ origin: '*', credentials: true }));
//const cors = require("cors");
app.use(cors({
  origin: "https://ict-cert.vercel.app"
}));

// ✅ Ensure upload directories exist
const uploadDir = path.join(__dirname, "uploads");
const scheduleDir = path.join(__dirname, "uploads/schedules");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(scheduleDir)) fs.mkdirSync(scheduleDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const scheduleUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, scheduleDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  })
});

// ✅ Connect to MongoDB
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));
  
  // Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ✅ SCHEMAS
const studentSchema = new mongoose.Schema({
  name: String,
  matric: { type: String, unique: true },
  department: String,
  level: String,
  phone: String,
  email: { type: String, unique: true },
  password: String,
  passport: String,
});

const certificateSchema = new mongoose.Schema({
  email: { type: String, required: true },
  matric: { type: String, required: true, unique: true },
  token: { type: String, required: true },
  appliedAt: { type: Date, default: Date.now },
  status: { type: String, default: "pending" }  // 'pending', 'approved', 'rejected'
});

const transactionSchema = new mongoose.Schema({
  email: String,
  amount: Number,
  reference: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});
const tokenSchema = new mongoose.Schema({
  studentName: String,
  studentEmail: String,
  amount: Number,
  reference: String,
  token: String,
  status: { type: String, enum: ['pending', 'success', 'used'], default: 'pending' },
  source: { type: String, enum: ['payment', 'manual'], default: 'manual' }, // ✅ NEW
  createdAt: { type: Date, default: Date.now },
});

// ✅ MODELS
const Student = mongoose.model("Student", studentSchema);

const CertificateApplication = mongoose.model("CertificateApplication", certificateSchema);

const Transaction = mongoose.model("Transaction", transactionSchema);

const Token = mongoose.model("Token", tokenSchema);

// Department mapping
function getDepartmentAndLevelFromMatric(matric) {
  if (matric.startsWith("HND/")) {
    // HND student format: HND/23/01/001
    const parts = matric.split("/");
    const deptCode = parts[2]; // e.g., "01"

    const hndMap = {
      "01": "Accountancy",
      "02": "Biochemistry",
      "03": "Business Administration",
      "04": "Computer Engineering",
      "05": "Computer Science",
      "06": "Electrical Engineering",
      "07": "Mass Communication",
      "08": "Microbiology"
    };

    return {
      department: hndMap[deptCode] || "Unknown",
      level: "HND"
    };

  } else {
    // ND student format: e.g., Cos/023456
    const prefix = matric.split("/")[0];
    const ndMap = {
      "S": "Science Laboratory Technology",
      "COS": "Computer Science",
      "COE": "Computer Engineering",
      "B": "Business Administration",
      "EST": "Estate Management",
      "E": "Electrical Engineering",
      "M": "Mass Communication",
      "A": "Accountancy",
      "MLT": "Medical Laboratory Technology"
    };

    return {
      department: ndMap[prefix] || "Unknown",
      level: "ND"
    };
  }
      }
      
      
// ✅ Save access for a department + level (allow or block)
app.post("/api/admin/access-control", async (req, res) => {
  const { department, level, status } = req.body;

  if (!department || !level || !status) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    const existing = await AllowedGroup.findOne({ department, level });

    if (existing) {
      existing.status = status;
      await existing.save();
    } else {
      await AllowedGroup.create({ department, level, status });
    }

    res.json({ message: `Access for ${department} ${level} set to ${status}.` });
  } catch (err) {
    console.error("Access control error:", err);
    res.status(500).json({ message: "Error saving access rule." });
  }
});

// ✅ Get all access rules
app.get("/api/admin/access-groups", async (req, res) => {
  try {
    const rules = await AllowedGroup.find();
    res.json(rules);
  } catch (err) {
    res.status(500).json({ message: "Failed to load access groups." });
  }
});

// ✅ Route to create a reusable Paystack split code
app.post('/api/split/create', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.paystack.co/split',
      {
        name: 'CBT Token Split Group',
        type: 'percentage',
        currency: 'NGN',
        subaccounts: [
          {
            subaccount: 'ACCT_370jqx88t6rgcz4',
            share: 70
          }
        ],
        bearer_type: 'subaccount', // ✅ Subaccount bears the transaction fee
        bearer_subaccount: 'ACCT_370jqx88t6rgcz4'
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      message: '✅ Split group created successfully',
      split_code: response.data.data.split_code,
      full_data: response.data.data
    });
  } catch (error) {
    console.error("❌ Split creation error:", error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to create split group',
      details: error.response?.data || error.message
    });
  }
});
// ✅ Initialize payment for Paystack popup (NO callback_url)
//app.post('/api/payment/initialize', async (req, res) => {
//  const { email, amount } = req.body;

//  try {
//    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
    //  email,
  //    amount: amount * 100     split_code: 'SPL_wRVJKCtJsj'
//    }, {
    //  headers: {
   //     Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    //    'Content-Type': 'application/json',
 //     },
//    });

 //   const { authorization_url, reference } = response.data.data;

//    await Transaction.create({ email, amount, reference });
//    res.json({ authorization_url, reference })  } catch (error) {
//    console.error("Init error:", error.response?.data || error.message);
  //  res.status(500).json({ error: 'Payment initialization failed' })
//}
//});

// ✅ Initialize payment for Paystack popup (cleaned for test mode no split code)
app.post('/api/payment/initialize', async (req, res) => {
  const { email, amount } = req.body;

  try {
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email,
      amount: amount * 100
    }, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const { authorization_url, reference } = response.data.data;

    await Transaction.create({ email, amount, reference });
    res.json({ authorization_url, reference });
  } catch (error) {
    console.error("Init error:", error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});
// ✅ Verify payment and generate token
app.get('/api/payment/verify/:reference', async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });

    const status = response.data.data.status;

    const transaction = await Transaction.findOneAndUpdate(
      { reference },
      { status },
      { new: true }
    );

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    if (status === 'success') {
      const existingToken = await Token.findOne({ reference });
      if (existingToken) {
        return res.json({
          message: 'Payment already verified, token exists',
          token: existingToken.token,
          transaction,
        });
      }

      const tokenCode = 'CBT-' + Math.floor(100000 + Math.random() * 900000);

      const newToken = new Token({
        token: tokenCode,
        studentEmail: transaction.email,
        amount: transaction.amount,
        reference,
        status: 'success',
        createdAt: new Date()
      });

      await newToken.save();

      return res.json({
        message: 'Payment verified and token issued',
        token: tokenCode,
        transaction,
      });
    } else {
      return res.status(400).json({ message: 'Payment not successful', status });
    }
  } catch (error) {
    console.error("Verify error:", error.message);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
});

// Validate Email Before Auto-Generating
app.post('/api/tokens/check-email', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ allowed: false, message: "Invalid email format" });
  }

  const existingTokens = await Token.find({ studentEmail: email, source: 'manual' });

  if (existingTokens.length >= 2) {
    return res.status(403).json({ allowed: false, message: "This email has reached the maximum token limit." });
  }

  res.json({ allowed: true });
});

// ✅ Save transaction manually
app.post('/api/transactions/save', async (req, res) => {
  const { email, amount, reference } = req.body;

  try {
    const existing = await Transaction.findOne({ reference });
    if (!existing) {
      await Transaction.create({ email, amount, reference });
    }
    res.json({ message: 'Transaction saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save transaction' });
  }
});


// ✅ Get all tokens
app.get('/api/tokens', async (req, res) => {
  try {
    const tokens = await Token.find().sort({ createdAt: -1 });
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: "Error fetching tokens" });
  }
});

// ✅ Validate token route
app.get('/api/tokens/validate/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const found = await Token.findOne({ token });

    if (!found) {
      return res.status(404).json({ valid: false, message: "Token not found." });
    }

    if (found.status !== 'success') {
      return res.status(400).json({ valid: false, message: "Token is not valid or already used." });
    }

    return res.json({ valid: true });
  } catch (err) {
    console.error("Token validation error:", err.message);
    res.status(500).json({ valid: false, message: "Server error." });
  }
});

app.post('/api/apply-certificate', async (req, res) => {
  const { email, matric, token } = req.body;

  if (!email || !matric || !token) {
    return res.status(400).json({ message: "Email, matric number, and token are required." });
  }

  try {
    // 1. Validate Token
    const validToken = await Token.findOne({ token, studentEmail: email, status: 'success' });
    if (!validToken) {
      return res.status(400).json({ message: "Invalid or unauthorized token." });
    }

    // 2. Check for duplicate matric number
    const existingApp = await CertificateApplication.findOne({ matric });
    if (existingApp) {
      return res.status(409).json({ message: "Application with this matric number already exists." });
    }

    // 3. Save application
    const newApp = new CertificateApplication({ email, matric, token });
    await newApp.save();

    // Optional: Invalidate token to prevent reuse
    validToken.status = "used";
    await validToken.save();

    res.status(201).json({ message: "Certificate application submitted successfully." });
  } catch (err) {
    console.error("Certificate apply error:", err);
    res.status(500).json({ message: "Failed to submit application." });
  }
});

//✅ Apply Certificate 
app.post('/api/apply-certificate', async (req, res) => {
  const { email, matric, token } = req.body;

  if (!email || !matric || !token) {
    return res.status(400).json({ message: "Email, matric number, and token are required." });
  }

  try {
    // 1. Validate Token
    const validToken = await Token.findOne({ token, studentEmail: email, status: 'success' });
    if (!validToken) {
      return res.status(400).json({ message: "Invalid or unauthorized token." });
    }

    // 2. Check for duplicate matric number
    const existingApp = await CertificateApplication.findOne({ matric });
    if (existingApp) {
      return res.status(409).json({ message: "Application with this matric number already exists." });
    }

    // 3. Save application
    const newApp = new CertificateApplication({ email, matric, token });
    await newApp.save();

    // Optional: Invalidate token to prevent reuse
    validToken.status = "used";
    await validToken.save();

    res.status(201).json({ message: "Certificate application submitted successfully." });
  } catch (err) {
    console.error("Certificate apply error:", err);
    res.status(500).json({ message: "Failed to submit application." });
  }
});

// ✅ Get Applied Students 
app.get('/api/applied-students', async (req, res) => {
  try {
    const students = await Student.find().sort({ createdAt: -1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

//✅ Create PDF and Email Certificate 
app.post('/api/apply-certificate', upload.single('passport'), async (req, res) => {
  try {
    const { fullName, matricNumber, department, level, phone, email, token } = req.body;

    const existingToken = await Token.findOne({ token });

    if (!existingToken || existingToken.used) {
      return res.status(400).json({ error: 'Invalid or already used token' });
    }

    // Mark token as used
    existingToken.used = true;
    await existingToken.save();

    // Save applicant in DB
    const student = new Student({ fullName, matricNumber, department, level, phone, email, passport: req.file.path });
    await student.save();

    // Create PDF
    const pdfPath = `./certificates/${matricNumber}-certificate.pdf`;
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdfPath));
    doc.fontSize(20).text('Certificate of Completion', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`This certifies that ${fullName}`, { align: 'center' });
    doc.text(`from ${department} (${level})`, { align: 'center' });
    doc.text(`Matric No: ${matricNumber}`, { align: 'center' });
    doc.moveDown();
    doc.text(`Issued by Certificate Board`, { align: 'center' });
    doc.end();

    // Send email with attachment
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your Certificate is Ready',
      text: `Hello ${fullName},\n\nAttached is your official certificate.\n\nBest regards,\nCertificate Team`,
      attachments: [{
        filename: `${matricNumber}-certificate.pdf`,
        path: pdfPath
      }]
    };

    await transporter.sendMail(mailOptions);

    res.json({ message: 'Certificate applied and emailed successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 🟢 Default Route
app.get("/", (req, res) => {
  res.send("✅ CBT System + Payment API is running!");
});

// 🟢 Start the Server
app.listen(PORT, () => {
  console.log(`🚀 Server is live on port ${PORT}`);
});
