import mongoose from "mongoose";

const doctorsSchema =new mongoose.Schema({
    doctorId:{
        type:String,
        required:true,
        unique:true
    },
    name:{
        type:String,
        required:true,
    },
    email:{
        type:String,
        required:true,
    }, 
    phonenumber:{
        type:Number,
        required:true,
    },
    specialization:{
        type:String,
        required:true,
    },
    bio:{
        type:String,
    }
})

export const Doctor =  mongoose.model("Doctor",doctorsSchema);