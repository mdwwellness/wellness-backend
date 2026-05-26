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
}, { timestamps: true, versionKey: false })

const AppointmentBooking = mongoose.model('AppointmentBooking', AppointmentBookingSchema);

export default AppointmentBooking;
