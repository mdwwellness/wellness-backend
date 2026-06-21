import mongoose, { Schema } from "mongoose";

const AppointmentBookingSchema = new Schema({
    // ── Required for every record ──
    name: {
        type: String,
        required: true,
        trim: true
    },
    phonenumber: {
        type: Number,
        required: true,
    },

    // ── Legacy fields: now OPTIONAL so enquiry-stage records (which don't
    //    yet have a slot, category, etc.) can be created. Existing records
    //    that already populate them stay valid. ──
    slot: {
        time: { type: String },
        date: { type: Date },
    },
    location: {
        type: String,
    },
    typeOfappointment: {
        type: String,
        enum: ["consultation", "appointment"],
    },
    category: {
        type: String,
    },
    age: {
        type: Number,
    },
    email: {
        type: String,
    },
    note: {
        type: String,
    },
    doctor: {
        type: String,
    },
    doctorId: {
        type: String,
        ref: "Doctor",
    },
    therapyStartTime: {
        type: String,
    },
    therapyEndTime: {
        type: String,
    },

    // ── NEW: structured time window the client prefers to be reached in. ──
    //    Stored as 24-hour "HH:MM" strings; frontend renders with AM/PM.
    preferredReachOutTime: {
        from: { type: String },
        to: { type: String },
    },

    // ── NEW: funnel checkpoint — executive reach-out ──
    executiveReachedOut: {
        type: Boolean,
        default: false,
    },
    executiveReachedOutAt: {
        type: Date,
    },

    // ── NEW: funnel checkpoint — online consultation ──
    consultationSlot: {
        date: { type: String },
        time: { type: String },
    },
    consultationCompleted: {
        type: Boolean,
        default: false,
    },
    consultationCompletedAt: {
        type: Date,
    },

    // ── NEW: funnel checkpoint — physio assignment ──
    physioSlot: {
        date: { type: String },
        time: { type: String },
    },
    physioAssignmentConfirmed: {
        type: Boolean,
        default: false,
    },
    physioAssignmentConfirmedAt: {
        type: Date,
    },

    // ── Status: added "enquiry" as first allowed value. Fixed `defaul` typo. ──
    status: {
        type: String,
        enum: ["enquiry", "scheduled", "ongoing", "completed", "cancelled"],
        default: "enquiry",
    },

    // ── Human-readable, sequential enquiry ID. Allocated atomically on creation.
    //    Format: ENQ-0001, ENQ-0002, ... ENQ-9999, ENQ-10000.
    //    sparse: true allows null for legacy records that haven't been backfilled. ──
    enquiryId: {
        type: String,
        unique: true,
        sparse: true,
        index: true,
    },

    // ── Which back-office staff member is handling this lead.
    //    Auto-populated when an executive first ticks "Mark as reached out".
    //    Editable via dropdown in the dashboard drawer. ──
    assignedTo: {
        userId: { type: String },
        name:   { type: String },
    },

    // ── Audit field: who FIRST claimed this lead (ticked reach-out or
    //    booked a slot or otherwise advanced the funnel). Different from
    //    assignedTo (which is the current owner and can be reassigned).
    //    reachedOutBy is set once on first action and is intended to be
    //    immutable in the dashboard UI for non-admin users — only admins
    //    can override via the drawer. Backend doesn't enforce immutability;
    //    that's a frontend concern. ──
    reachedOutBy: {
        userId: { type: String },
        name:   { type: String },
    },

    // ── Append-only activity log: who did what, when (dashboard audit). ──
    activityLog: [
        {
            at:     { type: String },
            userId: { type: String },
            name:   { type: String },
            action: { type: String },
            _id: false,
        },
    ],

    // ── Reason captured when a status is manually overridden (e.g. cancel). ──
    statusNote: {
        type: String,
    },

    // ── Funnel checkpoint — payment (patient → clinic) ──
    paymentReceived: {
        type: Boolean,
        default: false,
    },
    paymentAmount: {
        type: Number,
    },
    paymentMethod: {
        type: String,
        enum: ["cash", "upi", "card", "bank", "other"],
    },
    paymentReceivedAt: {
        type: Date,
    },

    // ── Funnel checkpoint — completion ──
    completedAt: {
        type: Date,
    },

    // ── Origin of the record: "public_booking_form" | "dashboard" | undefined ──
    source: {
        type: String,
    },

    // ── How many times this person submitted a booking while this lead stayed
    //    OPEN. Starts at 1; each repeat public submission bumps it (and is
    //    logged in activityLog) instead of creating a duplicate row. ──
    repeatCount: {
        type: Number,
        default: 1,
    },

    // ── Follow-up tracking: how many times an executive tried to call this lead
    //    but couldn't connect (no answer). Drives the /dashboard/follow-ups view.
    //    Stays at 0 for fresh, never-attempted leads. ──
    reachAttempts: {
        type: Number,
        default: 0,
    },
    lastAttemptAt: {
        type: Date,
    },
}, { timestamps: true, versionKey: false })

const AppointmentBooking = mongoose.model('AppointmentBooking', AppointmentBookingSchema);

export default AppointmentBooking;
