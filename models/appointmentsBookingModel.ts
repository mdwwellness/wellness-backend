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
    category: {
        type: String,
        required: true,
        enum: ["category1", "category2", "category3", "category4","category5"]
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

    doctor:{
        type:String,
        required:true,
    },
    doctorId:{
        type:String,
        ref:"Doctor",
        required:true
    }
})

const AppointmentBooking = mongoose.model('AppointmentBooking', AppointmentBookingSchema);

export default AppointmentBooking;