/**
 * OpenAPI spec behind /api/docs (Swagger UI). Covers the public and
 * customer-app endpoints an outside developer integrates with; staff routes are
 * deliberately left out. Keep it in step with docs/api.md when these change.
 */

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
  servers: [{ url: "/", description: "This server" }],
  tags: [
    { name: "Public", description: "No login needed." },
    { name: "Customer sign-in", description: "Phone OTP. Returns a 7-day Bearer token." },
    { name: "Customer profile", description: "Needs `Authorization: Bearer <token>`." },
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
