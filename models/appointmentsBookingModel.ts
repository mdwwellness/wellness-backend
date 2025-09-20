import mongoose, { Schema } from "mongoose";

const AppointmentBookingSchema = new Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    slot: {
        time:{
            type:String,
            required:true,
        },
        date:{
            type:Date,
            required:true,
        }
    },
    location: {
        type: String,
        required: false,
    },
    typeOfappointment:{
        type:String,
        required:true,
        enum:["consultation","appointment"]
    },
    category: {
        type: String,
        required: true,
    },
    age: {
        type: Number,
        required: true,
    },
    phonenumber: {
        type: Number,
        required: true,
    },
    email:{
        type:String
    },
    note:{
        type:String,
        required:false
    },
    status:{
        type:String,
        enum:["completed","ongoing","cancelled","scheduled"],
        defaul:"scheduled"
    },
    doctor:{
        type:String,
    },
    doctorId:{
        type:String,
        ref:"Doctor",
    },
    therapyStartTime:{
        type:String
    },
    therapyEndTime:{
        type:String
    }
},{ timestamps: true, versionKey: false })

const AppointmentBooking = mongoose.model('AppointmentBooking', AppointmentBookingSchema);

export default AppointmentBooking;