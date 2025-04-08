import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import express from "express";
import path from "path";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { User } from "./models/User.js";  
import { Login } from "./models/Login.js";  
import mongoose from "mongoose";
import fetch from 'node-fetch';
import session from 'express-session';
import MongoStore from 'connect-mongo';  
import cors from 'cors';
import bodyParser from "body-parser";

mongoose.connect("mongodb://localhost:27017/whatsappClientManager", {})
  .then(() => console.log("MongoDB connected successfully"))
  .catch((err) => console.error("MongoDB connection error:", err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Client, LocalAuth } = pkg;

const app = express();
app.use(cors());

 

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});



app.use(session({
  secret: 'kucing',  
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: 'mongodb://localhost:27017/whatsappClientManager' }),
  cookie: { maxAge: 180 * 60 * 1000 }  
}));
app.use(express.json());
 app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));

const clients = [];

async function initializeClient(clientNumber, userType) {
  const client = new Client({ 
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  let qrCodeEnabled = false;

  client.on("qr", (qr) => {
    if (qrCodeEnabled) {
      qrcode.generate(qr, { small: true });
      io.emit("qr", { clientNumber, qr });
    }
  });

  client.on("ready", async () => {
    console.log(`Client ${clientNumber} is ready!`);
    const userNumber = client.info.wid.user;
    const timestamp = new Date().toLocaleString();

    await User.updateOne(
      { number: userNumber },
      { number: userNumber, time: timestamp, status: "online", userType: userType }, // Include userType
      { upsert: true }
    );

    io.emit("userLoggedIn", { number: userNumber, time: timestamp });
  });

  client.on("disconnected", async (reason) => {
    console.log(`Client ${clientNumber} was logged out:`, reason);
    const userNumber = client.info.wid.user;

    await User.updateOne({ number: userNumber }, { status: "offline" });

    io.emit("userDisconnected", { number: userNumber });

    qrCodeEnabled = false;
    const index = clients.findIndex((c) => c.info.wid.user === userNumber);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });

  qrCodeEnabled = true;
  await client.initialize();
  clients.push(client);

  client.on("message_create", async (message) => {
    const sender = message.from; 
    const currentUser = message.to;  

    const formattedCurrentUser = currentUser.split("@")[0];    
    console.log("Message sent to:", formattedCurrentUser);
  
    const formattedSender = sender.split("@")[0]; // Extract sender number
    const body = message.body;

    if(message.type === 'chat' && sender !== 'status@broadcast') {

      console.log(`Received message from ${formattedSender}: ${body}`);

      const client = await User.findOne({ number: formattedCurrentUser });
      console.log("Client found:", client);
  
      if (client && client.webhookUrl) {
        try {
          await fetch(client.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: sender,
              body: message.body,
              timestamp: message.timestamp
            })
          });
        } catch (error) {
          console.error("Error sending message to webhook:", error);
        }
      }

    }

  });
}

app.post("/initializeClient", async (req, res) => {
  const { clientNumber, userType } = req.body;
  const existingClient = clients.find((c) => c.info.wid.user === clientNumber);
  
  if (!existingClient) {
    await initializeClient(clientNumber, userType);
    res.status(200).send({ result: `Client ${clientNumber} initialized` });
  } else {
    res.status(200).send({ result: `Client ${clientNumber} is already initialized` });
  }
});

app.post("/updateWebhook", async (req, res) => {
  const { clientNumber, webhookUrl } = req.body;

  try {
    await User.updateOne(
      { number: clientNumber },
      { webhookUrl: webhookUrl }, // Update webhook URL
      { upsert: true }
    );
    res.status(200).send({ result: `Webhook URL updated for client ${clientNumber}` });
  } catch (error) {
    console.error(`Error updating webhook: ${error.message}`);
    res.status(500).send({ error: "Failed to update webhook URL. Please try again." });
  }
});

app.get("/clients", async (req, res) => {
  try {
    const clients = await User.find({});
    res.status(200).send(clients);
  } catch (error) {
    console.error("Error retrieving clients:", error);
    res.status(500).send({ error: "Failed to retrieve clients" });
  }
});

app.post("/logout/:clientNumber", async (req, res) => {
  const { clientNumber } = req.params;

  try {
    const client = await User.findOne({ number: clientNumber });

    if (!client) {
      return res.status(404).send({ error: "Client not found." });
    }

    await client.updateOne({ status: "offline" });
    io.emit("userDisconnected", { number: clientNumber });
    res.status(200).send({ result: `Client ${clientNumber} logged out successfully.` });
  } catch (error) {
    console.error(`Error logging out client ${clientNumber}:`, error);
    res.status(500).send({ error: "Failed to log out client." });
  }
});

app.delete("/deleteClient/:clientNumber", async (req, res) => {
  const { clientNumber } = req.params;

  try {
    const client = await User.findOne({ number: clientNumber });

    if (!client) {
      return res.status(404).send({ error: "Client not found." });
    }

    await client.deleteOne();
    res.status(200).send({ result: `Client ${clientNumber} deleted successfully.` });
  } catch (error) {
    console.error(`Error deleting client ${clientNumber}:`, error);
    res.status(500).send({ error: "Failed to delete client." });
  }
});



app.post("/sendMessage", async (req, res) => {
  const { sender, to, message } = req.body;

  if (!sender || !to || !message) {
    return res.status(400).send({ error: "Sender, recipient, and message are required." });
  }

  console.log("Sender:", sender, "Recipient:", to, "Message:", message);

  const client = clients.find((c) => c.info.wid.user === sender);

  if (!client) {
    console.log("Client not found for sender:", sender);
    return res.status(404).send({ error: "Client not found." });
  }

  const formattedRecipient = `${to}@c.us`;

  try {
    await client.sendMessage(formattedRecipient, message);
    res.status(200).send({ result: "Message sent successfully." });
  } catch (error) {
    console.error("Error sending message:", JSON.stringify(error, null, 2));
    res.status(500).send({ error: "Failed to send message." });
  }
});

 

app.get('/sendMessagePage', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tesPesan.html'));
});

 

app.get('/users', async (req, res) => {
  try {
      const users = await Login.find({}); // Exclude password from the response
      res.status(200).send(users);
  } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).send({ message: 'Failed to fetch users.' });
  }
});

app.put('/edit/:username', async (req, res) => {
  const { username } = req.params;
  const { username: newUsername, password } = req.body;

  try {
      // Directly update the password without hashing
      await Login.updateOne({ username }, { username: newUsername, password });
      res.status(200).send({ message: 'User updated successfully!' });
  } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).send({ message: 'Failed to update user.' });
  }
});

app.delete('/delete/:username', async (req, res) => {
  const { username } = req.params;

  try {
      await Login.deleteOne({ username });
      res.status(200).send({ message: 'User deleted successfully!' });
  } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).send({ message: 'Failed to delete user.' });
  }
});



app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await Login.findOne({ username });
    if (!user || user.password !== password) {
      return res.status(401).send({ message: 'Invalid username or password.' });
    }

    req.session.username = username; // Store username in session
    req.session.userType = user.userType; // Store user type in session
    res.status(200).send({ success: true, message: 'Login successful!' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send({ message: 'Login failed. Please try again.' });
  }
});



function isAuthenticated(req, res, next) {
  if (req.session && req.session.username) {
    return next();  
  }
  res.status(403).send({ message: 'Forbidden: You need to log in to access this page.' });
}

function isAuthorized(userType) {
  return (req, res, next) => {
    if (userType.includes(req.session.userType)) {
      return next();  
    }
    res.status(403).send({ message: 'Forbidden: You do not have access to this page.' });
  };
}

app.get("/admin.html", isAuthenticated, isAuthorized('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, "protected", "admin.html"));
});

app.get("/users.html", isAuthenticated, isAuthorized('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, "protected", "users.html"));
});

app.get('/index.html', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'index.html'));
});

app.get('/register.html', isAuthenticated, isAuthorized('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'register.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
} );


 



app.post('/register', async (req, res) => {
  const { username, password, userType } = req.body;

  try {
      // Directly save the plain password without hashing
      const newUser = new Login({ username, password, userType });
      await newUser.save();
      res.status(201).send({ 
          message: 'User registered successfully!', 
          user: { username, userType } // Return user info
      });
  } catch (error) {
      console.error('Registration error:', error);
      res.status(500).send({ message: 'Registration failed. Please try again.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).send({ message: 'Logout failed. Please try again.' });
    }
    res.status(200).send({ message: 'Logout successful.' });
  });
});


app.get('/checkSession', (req, res) => {
  if (req.session.username) {
    res.status(200).send({ message: `Session active for user: ${req.session.username}` });
  } else {
    res.status(401).send({ message: 'No active session.' });
  }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


app.get('/userType', (req, res) => {
  if (req.session && req.session.userType) {
      res.status(200).send({ userType: req.session.userType });
  } else {
      res.status(403).send({ error: 'User type not found.' });
  }
});
