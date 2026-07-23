require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // false für Port 587 (STARTTLS)
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

console.log("Teste Verbindung zu:", process.env.SMTP_HOST);

transporter.verify(function(error, success) {
    if (error) {
        console.error("? Verbindung fehlgeschlagen:", error.message);
    } else {
        console.log("? Server ist bereit, E-Mails zu senden!");
    }
    process.exit();
});
 