# Smart Water Monitoring & Pump Control System

An enterprise-grade, real-time IoT Water Level Monitoring and Automated Pump Control Dashboard for ESP32 hardware nodes.

---

## 🌟 Features

- **Real-Time Telemetry & Control**: WebSocket stream for continuous water level, temperature, humidity, pump status, and active alarm monitoring.
- **Automated Pump Control**: L293D H-Bridge motor driver integration with automatic start/stop and emergency overflow safety shutoff.
- **Role-Based Authentication**: Secure JWT-based authentication with role authorization (`admin`, `developer`, `user`). Passwords hashed using `bcrypt`.
- **OTP Password Reset**: 6-digit cryptographically secure OTP password reset delivered via Gmail SMTP/Nodemailer.
- **Unified Event & History**: Single SQLite source of truth for telemetry, pump activations, alarms, and system events with CSV export support.
- **Persistent Notifications & Daily Digest**: Individual user email preferences, emergency alerts, and server-side scheduled daily digest reports (Asia/Kolkata timezone).
- **Responsive Dashboard**: Vibrant, modern UI built with vanilla JavaScript, Chart.js, and CSS grid layouts.

---

## 🛠️ Technology Stack

- **Backend**: Node.js, Express.js, WebSocket (`ws`), SQLite3 (`sqlite` & `sqlite3`)
- **Security**: JSON Web Tokens (`jsonwebtoken`), `bcryptjs`, Rate Limiting
- **Email Dispatch**: Nodemailer (Gmail SMTP)
- **Frontend**: HTML5, CSS3, Modern Vanilla JavaScript (ES6+), Chart.js, Remix Icons

---

## 📂 Project Structure

```
WaterLevelProject/
├── database.js                 # SQLite database initialization & migrations
├── server.js                   # Entry point server & WebSocket initialization
├── .env                        # Environment configuration (credentials template)
├── package.json                # Project dependencies & scripts
├── middleware/
│   ├── auth.js                 # JWT & role authorization middleware
│   └── validation.js           # Email, password, threshold validation & rate limiters
├── routes/
│   ├── authRoutes.js           # Authentication & OTP routes (/api/auth)
│   ├── deviceRoutes.js         # ESP32 device status routes (/api/devices)
│   ├── telemetryRoutes.js      # Telemetry & pump control routes (/api/status, /api/telemetry)
│   ├── historyRoutes.js        # System historical logs & CSV export (/api/history)
│   ├── notificationRoutes.js   # User alerts & email preferences (/api/notifications)
│   ├── analyticsRoutes.js      # DB-aggregated performance metrics (/api/analytics)
│   └── settingsRoutes.js       # System configuration & user profile (/api/settings)
├── services/
│   ├── authService.js          # Registration, login, OTP & password service
│   ├── telemetryService.js     # State cache, threshold logic, heartbeat watchdog
│   ├── emailService.js         # Nodemailer SMTP email dispatch service
│   ├── analyticsService.js     # Database aggregation analytics service
│   └── notificationService.js  # User notifications & preferences service
├── utils/
│   └── constants.js            # Enums, roles, error codes & default thresholds
└── public/
    ├── index.html              # Single page application structure
    ├── css/
    │   └── style.css           # Modern theme styling & responsive layout
    └── js/
        └── app.js              # Frontend UI controller & WebSocket stream
```

---

## 🚀 Setup & Installation

### 1. Prerequisites
- Node.js (v16+ recommended)
- npm or yarn

### 2. Environment Configuration
Create a `.env` file in the root directory (or use `.env`):

```env
PORT=5000
NODE_ENV=development
JWT_SECRET=your_secure_jwt_secret_key_2026

# SMTP Email Dispatch Configuration (Gmail / Standard SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=Smart Water System <your-email@gmail.com>

# Scheduler Settings
TIMEZONE=Asia/Kolkata
DAILY_DIGEST_HOUR=8
DAILY_DIGEST_MINUTE=0
```

### 3. Installation
```bash
npm install
```

### 4. Running the Application
```bash
# Production mode
npm start

# Development mode
npm run dev
```

The application will launch on `http://localhost:5000`.

---

## 🔑 Authentication & Authorization

- **Default Administrator Account**:
  - Username: `admin`
  - Password: `admin123`
- Newly registered accounts default to the `user` role.
- **Admin Password Change**: Available under **Settings -> Admin Security & Password Change** for logged-in `admin`/`developer` accounts.

---

## 📡 API Overview

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/api/auth/register` | Register new user account | No |
| `POST` | `/api/auth/login` | Authenticate user & get JWT token | No |
| `POST` | `/api/auth/forgot-password` | Request password reset 6-digit OTP | No (Rate Limited) |
| `POST` | `/api/auth/verify-otp` | Verify 6-digit OTP | No (Rate Limited) |
| `POST` | `/api/auth/reset-password` | Set new password via verified OTP | No |
| `POST` | `/api/auth/change-password` | Update logged-in admin password | Yes (Admin) |
| `GET`  | `/api/status` | Current system state & latest logs | No |
| `POST` | `/api/telemetry` | Post hardware sensor reading from ESP32 | No |
| `POST` | `/api/pump/control` | Change pump mode (AUTO/MANUAL) & manual toggle | Yes |
| `GET`  | `/api/history/full` | Get historical events (supports category, search, CSV) | No |
| `GET`  | `/api/analytics` | Get DB metrics for Today, 7D, Month, Year | No |
| `GET`  | `/api/notifications` | Get user notifications & unread count | Yes |
| `POST` | `/api/notifications/preferences` | Save email notification settings | Yes |
| `POST` | `/api/thresholds` | Save water thresholds configuration | Yes |

---

## 🧪 Testing Verification

Run tests to verify functionality:

1. **Authentication**: Register account, sign in, verify token, test invalid credentials.
2. **OTP Reset Flow**: Request OTP via email, attempt verification with incorrect code (verify rate limit), set new password, sign in with new password.
3. **Thresholds & Control**: Set Low (20%), Full (85%), Overflow (95%). Test validation rejection for values >100 or invalid ordering.
4. **Notifications**: Verify unread count badge on sidebar, mark read, verify daily digest manual trigger.
5. **Analytics & History**: Test time range filters (Today, 7D, Month, Year) and export CSV download.

---

## 🔒 Security Notes

- Do not commit `.env` containing live SMTP passkeys or JWT secrets to source repositories.
- Standard input validation and parameterized SQL queries protect against injection vulnerabilities.
