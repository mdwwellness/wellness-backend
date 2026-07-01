import express from "express";
import type { Request, Response } from "express";
import userAuth from "../middlewares/userAuth.ts";
import {
  createCustomer,
  getCustomerById,
  getCustomers,
  updateCustomer,
} from "../controllers/customerController.ts";

const customerRouter = express.Router();

customerRouter.get("/", userAuth, getCustomers);
customerRouter.post("/", userAuth, createCustomer);
customerRouter.get("/:customerId", userAuth, getCustomerById);
customerRouter.patch("/:customerId", userAuth, updateCustomer);

export default customerRouter;

