/**
 * OpenAPI spec behind /api/docs (Swagger UI). Covers the public and
 * customer-app endpoints an outside developer integrates with; staff routes are
 * deliberately left out. Keep it in step with docs/api.md when these change.
 */

export const PRODUCTION_URL = "https://wellness-backend-1-wya5.onrender.com";

const json = (schema: object, example?: object) => ({
  "application/json": { schema, ...(example && { example }) },
});

const error = (description: string, message: string) => ({
  description,
  content: json({ $ref: "#/components/schemas/Error" }, { success: false, message }),
});

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "MDW Wellness API",
    version: "1.0.0",
    description:
      "Public and Customers' App endpoints. **\"Try it out\" calls the server this page is served from**: " +
      "on production that creates real enquiries, so use a test name and your own phone number.\n\n" +
      "Every response is `{ success, message, data? }`. Check `success`; `message` is written for customers.",
  },
  // Absolute, not "/": tools join server + path naively ("/" gave "//api/...").
  // The /api/docs page adds the server it's served from on top of this.
  servers: [{ url: PRODUCTION_URL, description: "Production" }],
  tags: [
    { name: "Public", description: "No login needed." },
    { name: "Customer sign-in", description: "Phone OTP. Returns a 7-day Bearer token." },
    { name: "Customer profile", description: "Needs `Authorization: Bearer <token>`." },
    { name: "Customer bookings", description: "Needs `Authorization: Bearer <token>`." },
  ],
  paths: {
    "/api/appointments/public": {
      post: {
        tags: ["Public"],
        summary: "Submit a booking request",
        description:
          "Creates an enquiry; the team calls the customer back. A repeat from the same phone + name for the same " +
          "`service` while the enquiry is still open is merged into it (200). Limit: 5 per minute per IP.",
        requestBody: {
          required: true,
          content: json(
            { $ref: "#/components/schemas/BookingRequest" },
            {
              name: "Asha Verma",
              phonenumber: 9876543210,
              email: "asha@example.com",
              typeOfappointment: "consultation",
              service: "Online Consultation",
              preferredReachOutTime: { from: "10:00", to: "12:00" },
              note: "Lower back pain for two weeks",
            },
          ),
        },
        responses: {
          201: {
            description: "New enquiry created",
            content: json(
              { $ref: "#/components/schemas/BookingCreated" },
              { success: true, message: "Booking received - our team will reach out shortly.", data: { enquiryId: "ENQ-0084" } },
            ),
          },
          200: {
            description: "Merged into the customer's open enquiry",
            content: json(
              { $ref: "#/components/schemas/BookingCreated" },
              {
                success: true,
                message: "Thanks! We already have your enquiry - our team will reach out, and we've noted your latest details.",
                data: { enquiryId: "ENQ-0084", repeatCount: 2 },
              },
            ),
          },
          400: error("Name or phone missing / invalid", "Phone number is required (numeric)."),
          429: error("Rate limit", "Too many submissions. Please try again in a minute."),
        },
      },
    },
    "/api/appointments/pay/{token}": {
      get: {
        tags: ["Public"],
        summary: "Show what a customer owes",
        description:
          "Backs the payment link staff send (`.../pay/<token>`). Read-only; never returns phone, address or therapist. " +
          "Limit: 60 per minute per IP.",
        parameters: [
          { name: "token", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{32}$" }, description: "32 hex characters from the payment link" },
        ],
        responses: {
          200: {
            description: "Amount due",
            content: json(
              { $ref: "#/components/schemas/PaymentSummaryResponse" },
              {
                success: true,
                message: "ok",
                data: {
                  enquiryId: "ENQ-0081",
                  name: "Asha Verma",
                  typeOfappointment: "appointment",
                  amount: 1600,
                  items: [{ label: "Home visit", amount: 1600 }],
                  paymentReceived: false,
                },
              },
            ),
          },
          404: error("Unknown or malformed token", "Payment link not found"),
        },
      },
    },
    "/api/customer-app/auth/otp": {
      post: {
        tags: ["Customer sign-in"],
        summary: "Send the sign-in code by SMS",
        description: "Limits per hour: 5 per phone, 20 per IP, 300 in total.",
        requestBody: {
          required: true,
          content: json(
            { type: "object", required: ["phone"], properties: { phone: { type: "string", example: "9876543210", description: "10-digit Indian mobile; +91 / leading 0 accepted" } } },
            { phone: "9876543210" },
          ),
        },
        responses: {
          200: { description: "Code sent", content: json({ $ref: "#/components/schemas/Message" }, { success: true, message: "OTP sent." }) },
          400: error("Not a valid Indian mobile", "Enter a valid 10-digit Indian mobile number."),
          429: error("Rate limit", "Too many OTP requests. Please try again later."),
          502: error("SMS provider failed", "Couldn't send the OTP right now. Please try again."),
          503: error("Phone sign-in not switched on", "Phone sign-in isn't available right now."),
        },
      },
    },
    "/api/customer-app/auth/verify": {
      post: {
        tags: ["Customer sign-in"],
        summary: "Sign in with the code",
        description:
          "Returns a Bearer token valid for 7 days. Click **Authorize** at the top and paste `data.token` to call the " +
          "signed-in endpoints. `name` is optional and only fills an account that has none.",
        requestBody: {
          required: true,
          content: json(
            {
              type: "object",
              required: ["phone", "otp"],
              properties: {
                phone: { type: "string", example: "9876543210" },
                otp: { type: "string", pattern: "^\\d{6}$", example: "123456", description: "Exactly 6 digits, sent as a string" },
                name: { type: "string", minLength: 2, maxLength: 80, example: "Asha Verma" },
              },
            },
            { phone: "9876543210", otp: "123456", name: "Asha Verma" },
          ),
        },
        responses: {
          200: {
            description: "Signed in",
            content: json(
              {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  message: { type: "string" },
                  data: {
                    type: "object",
                    properties: {
                      token: { type: "string" },
                      expiresIn: { type: "integer", example: 604800, description: "Seconds (7 days)" },
                      isNewAccount: { type: "boolean" },
                      profile: { $ref: "#/components/schemas/Profile" },
                    },
                  },
                },
              },
            ),
          },
          400: error("Bad phone / code / name, or wrong code", "Invalid or expired OTP."),
          403: error("Account blocked", "This account is blocked."),
          429: error("Rate limit", "Too many attempts. Please try again later."),
          503: error("Phone sign-in not switched on", "Phone sign-in isn't available right now."),
        },
      },
    },
    "/api/customer-app/me": {
      get: {
        tags: ["Customer profile"],
        summary: "Get my profile",
        security: [{ bearer: [] }],
        responses: {
          200: { description: "Profile", content: json({ type: "object", properties: { success: { type: "boolean" }, data: { $ref: "#/components/schemas/Profile" } } }) },
          401: error("Missing, invalid or expired token (code TOKEN_EXPIRED when expired)", "Sign in required."),
          403: error("Blocked or not a wellness account", "This account is blocked."),
        },
      },
      patch: {
        tags: ["Customer profile"],
        summary: "Update my profile",
        description:
          "Send only the fields to change; `null` (or `\"\"` for text) clears one. The phone can't be changed. " +
          "Unknown fields are rejected by name. The first save that has a name creates or links the clinic record. " +
          "Limit: 20 per hour.",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: "object",
              properties: {
                name: { type: "string", minLength: 2, maxLength: 80 },
                email: { type: "string", nullable: true },
                gender: { type: "string", nullable: true, enum: ["male", "female", "other"] },
                dob: { type: "string", nullable: true, example: "1990-04-12", description: "YYYY-MM-DD, not in the future" },
                address: { type: "string", nullable: true, maxLength: 200 },
                city: { type: "string", nullable: true, maxLength: 80 },
                pincode: { type: "string", nullable: true, pattern: "^[1-9]\\d{5}$" },
                emergencyContact: {
                  type: "object",
                  nullable: true,
                  properties: { name: { type: "string" }, phone: { type: "string" }, relation: { type: "string" } },
                },
              },
            },
            {
              gender: "female",
              dob: "1990-04-12",
              address: "12 Lake Road, Flat 3B",
              city: "Kolkata",
              pincode: "700091",
              emergencyContact: { name: "Ravi Verma", phone: "9876500000", relation: "Brother" },
            },
          ),
        },
        responses: {
          200: { description: "Updated", content: json({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data: { $ref: "#/components/schemas/Profile" } } }) },
          400: error("Invalid field, unknown field, or no name yet", "Unknown field(s): phone."),
          401: error("Not signed in", "Sign in required."),
          409: error("Email used by another account", "That email is already used by another account."),
          429: error("Rate limit", "Too many profile updates. Please try again later."),
        },
      },
    },
    "/api/customer-app/me/photo": {
      put: {
        tags: ["Customer profile"],
        summary: "Upload my profile photo",
        description:
          "Send the raw image bytes as the request body (not multipart, not base64) with `Content-Type` " +
          "image/jpeg, image/png or image/webp. Max 4 MB; resize on the device first. Replaces the previous photo. " +
          "Needs a name on the profile. Limit: 5 per hour.",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "image/jpeg": { schema: { type: "string", format: "binary" } },
            "image/png": { schema: { type: "string", format: "binary" } },
            "image/webp": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          200: { description: "Saved; profile with the new profilePhotoUrl", content: json({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data: { $ref: "#/components/schemas/Profile" } } }) },
          400: error("Empty, not a real image, or no name yet", "That file isn't a valid image."),
          401: error("Not signed in", "Sign in required."),
          413: error("Over 4 MB", "request entity too large"),
          415: error("Wrong Content-Type", "Send the photo as image/jpeg, image/png or image/webp."),
          429: error("Rate limit", "Too many photo uploads. Please try again later."),
        },
      },
    },
    "/api/customer-app/bookings": {
      get: {
        tags: ["Customer bookings"],
        summary: "List my bookings",
        description:
          "Every booking on the signed-in phone number, newest first (max 100). `amountDue` null means nothing is " +
          "payable on that row; use `payToken` with GET /api/appointments/pay/{token} to show the amount.",
        security: [{ bearer: [] }],
        responses: {
          200: { description: "Bookings", content: json({ type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { $ref: "#/components/schemas/CustomerBooking" } } } }) },
          401: error("Not signed in", "Sign in required."),
        },
      },
      post: {
        tags: ["Customer bookings"],
        summary: "Book while signed in",
        description:
          "Name, phone and email come from the signed-in account, never the body. Location defaults to the " +
          "profile address. A repeat for the same service while the enquiry is open is merged (200). Limit: 10 per hour.",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: json(
            {
              type: "object",
              required: ["service"],
              properties: {
                service: { type: "string", enum: ["Online Consultation", "Home Therapy", "Vitals Check"] },
                preferredReachOutTime: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
                note: { type: "string", maxLength: 1000 },
                vitals: { type: "array", items: { type: "string" }, description: "Only for Vitals Check" },
                location: { type: "string", maxLength: 300 },
              },
            },
            { service: "Home Therapy", preferredReachOutTime: { from: "10:00", to: "12:00" }, note: "Knee pain" },
          ),
        },
        responses: {
          201: { description: "New enquiry", content: json({ type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, data: { type: "object", properties: { enquiryId: { type: "string" }, folded: { type: "boolean" } } } } }, { success: true, message: "Booking received - our team will reach out shortly.", data: { enquiryId: "ENQ-0090", folded: false } }) },
          200: { description: "Merged into an open enquiry", content: json({ $ref: "#/components/schemas/Message" }) },
          400: error("Invalid or unknown field, or no name on the profile", "Add your name to your profile first."),
          401: error("Not signed in", "Sign in required."),
          429: error("Rate limit", "Too many bookings. Please try again later."),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "`data.token` from POST /api/customer-app/auth/verify" },
    },
    schemas: {
      Error: { type: "object", properties: { success: { type: "boolean", example: false }, message: { type: "string" } } },
      Message: { type: "object", properties: { success: { type: "boolean" }, message: { type: "string" } } },
      BookingRequest: {
        type: "object",
        required: ["name", "phonenumber"],
        properties: {
          name: { type: "string", minLength: 2 },
          phonenumber: { type: "integer", description: "A JSON number, not a string: 9876543210" },
          email: { type: "string" },
          location: { type: "string" },
          typeOfappointment: { type: "string", enum: ["consultation", "appointment"] },
          service: { type: "string", enum: ["Online Consultation", "Home Therapy", "Vitals Check"] },
          vitals: { type: "array", items: { type: "string" } },
          preferredReachOutTime: {
            type: "object",
            properties: { from: { type: "string", example: "10:00" }, to: { type: "string", example: "12:00" } },
          },
          note: { type: "string" },
          referralCode: {
            type: "string",
            example: "CK43Z",
            description: "Optional therapist referral code (from a ?ref= link). Case-insensitive; an unknown code is ignored, never an error.",
          },
        },
      },
      BookingCreated: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
          data: { type: "object", properties: { enquiryId: { type: "string" }, repeatCount: { type: "integer" } } },
        },
      },
      PaymentSummaryResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
          data: {
            type: "object",
            properties: {
              enquiryId: { type: "string" },
              name: { type: "string" },
              typeOfappointment: { type: "string" },
              amount: { type: "number", description: "Total still due, in rupees" },
              items: { type: "array", items: { type: "object", properties: { label: { type: "string" }, amount: { type: "number" } } } },
              paymentReceived: { type: "boolean" },
            },
          },
        },
      },
      CustomerBooking: {
        type: "object",
        properties: {
          enquiryId: { type: "string", nullable: true },
          patientName: { type: "string" },
          service: { type: "string", nullable: true },
          typeOfappointment: { type: "string", nullable: true },
          bookingKind: { type: "string", nullable: true, enum: ["intake", "course"] },
          status: { type: "string", enum: ["enquiry", "scheduled", "ongoing", "completed", "cancelled"] },
          slot: { type: "object", nullable: true, properties: { date: { type: "string", nullable: true }, time: { type: "string", nullable: true } } },
          therapistName: { type: "string", nullable: true },
          sessionsCompleted: { type: "integer" },
          totalSessions: { type: "integer", nullable: true },
          preferredReachOutTime: { type: "object", nullable: true, properties: { from: { type: "string" }, to: { type: "string" } } },
          amountDue: { type: "number", nullable: true, description: "null = nothing payable on this row" },
          paymentReceived: { type: "boolean" },
          payToken: { type: "string", nullable: true },
          createdAt: { type: "string", nullable: true },
        },
      },
      Profile: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          customerId: { type: "string", nullable: true, example: "CUST-0074" },
          phone: { type: "string", example: "9876543210" },
          name: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
          gender: { type: "string", nullable: true, enum: ["male", "female", "other"] },
          dob: { type: "string", nullable: true, example: "1990-04-12" },
          age: { type: "integer", nullable: true },
          address: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          pincode: { type: "string", nullable: true },
          emergencyContact: {
            type: "object",
            nullable: true,
            properties: { name: { type: "string" }, phone: { type: "string" }, relation: { type: "string", nullable: true } },
          },
          profilePhotoUrl: { type: "string", nullable: true },
          profileComplete: { type: "boolean" },
        },
      },
    },
  },
};
