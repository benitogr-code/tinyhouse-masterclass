import { IResolvers } from "apollo-server-express";
import { Request } from "express";
import { ObjectId } from "mongodb";
import {
  HostListingArgs, HostListingInput,
  ListingArgs, ListingBookingsArgs, ListingBookingsData,
  ListingsArgs, ListingsData, ListingsFilters, ListingsQuery
} from "./types";
import { Cloudinary, Google } from "../../../lib/api";
import { Database, Listing, ListingType, User } from "../../../lib/types";
import { authorize } from "../../../lib/utils";

function verifyHostListingInput(input: HostListingInput) {
  if (input.title.length > 100) {
    throw new Error("Listing title must be under 100 characters");
  }
  if (input.description.length > 5000) {
    throw new Error("Listing description must be under 5000 characters");
  }
  if (input.type !== ListingType.Apartment && input.type !== ListingType.House) {
    throw new Error("Listing type must be either an apartment or house");
  }
  if (input.price < 0) {
    throw new Error("Listing price must be greater than 0");
  }
}

export const listingResolvers: IResolvers = {
  Query: {
    listing: async (
      _root: undefined,
      args: ListingArgs,
      context: { db: Database; req: Request }
    ): Promise<Listing> => {
      const { db, req } = context;
      const listing = await db.listings.findOne({ _id: new ObjectId(args.id) })

      if (!listing) {
        throw new Error(`Listing could not be found (${args.id})`);
      }

      const viewer = await authorize(req, db);
      if (viewer && viewer._id == listing.host) {
        listing.authorized = true;
      }

      return listing;
    },
    listings: async (
      _root: undefined,
      args: ListingsArgs,
      context: { db: Database }
    ): Promise<ListingsData> => {
      try {
        const query: ListingsQuery = {};
        const data: ListingsData = {
          total: 0,
          result: [],
          region: null,
        };

        if (args.location) {
          const geoInfo = await Google.geocode(args.location);
          if (geoInfo.admin)
            query.admin = geoInfo.admin;

          if (geoInfo.city)
            query.city = geoInfo.city;

          if (geoInfo.country)
            query.country = geoInfo.country;
          else
            throw new Error("No country found for location");

          const cityText = geoInfo.city ? `${geoInfo.city}, ` : "";
          const adminText = geoInfo.admin ? `${geoInfo.admin}, ` : "";

          data.region = `${cityText}${adminText}${geoInfo.country}`;
        }

        const { db } = context;
        let cursor = await db.listings.find(query);

        if (args.filter === ListingsFilters.PriceHighest) {
          cursor = cursor.sort({ price: -1 });
        }
        else if (args.filter === ListingsFilters.PriceLowest) {
          cursor = cursor.sort({ price: 1 });
        }

        cursor.skip(args.page > 0 ? (args.page - 1) * args.limit : 0);
        cursor.limit(args.limit);

        data.total = await cursor.count();
        data.result = await cursor.toArray();

        return data;
      }
      catch (error) {
        throw new Error(`Failed to query listings: ${error.stack}`);
      }
    }
  },
  Mutation: {
    hostListing: async (
      _root: undefined,
      args: HostListingArgs,
      context: { db: Database; req: Request }): Promise<Listing> => {
        const { input } = args;
        verifyHostListingInput(input);

        const { db, req } = context;
        const viewer = await authorize(req, db);

        if (!viewer) {
          throw new Error("Viewer could not be found");
        }

        const { country, admin, city } = await Google.geocode(input.address);
        if (!country || !admin || !city) {
          throw new Error("Invalid address input");
        }

        const imageUrl = await Cloudinary.upload(input.image);

        const insertResult = await db.listings.insertOne({
          _id: new ObjectId(),
          ...input,
          image: imageUrl,
          bookings: [],
          bookingsIndex: {},
          country,
          admin,
          city,
          host: viewer._id
        });

        const newListing: Listing = insertResult.ops[0];

        await db.users.updateOne(
          { _id: viewer._id },
          { $push: { listings: newListing._id } }
        );

        return newListing;
    }
  },
  Listing: {
    id: (listing: Listing): string => {
      return listing._id.toString();
    },
    bookings: async (
      listing: Listing,
      args: ListingBookingsArgs,
      context: { db: Database }
    ): Promise<ListingBookingsData|null> => {
      try {
        if (!listing.authorized)
          return null;

        const data: ListingBookingsData = {
          total: 0,
          result: [],
        };

        const { db } = context;
        const cursor = await db.bookings.find({ _id: { $in: listing.bookings } });

        cursor.skip(args.page > 0 ? (args.page - 1) * args.limit : 0);
        cursor.limit(args.limit);

        data.total = await cursor.count();
        data.result = await cursor.toArray();

        return data;
      }
      catch (error) {
        throw new Error(`Failed to query listing bookings: ${error.message}`);
      }
    },
    bookingsIndex: (listing: Listing): string => {
      return JSON.stringify(listing.bookingsIndex);
    },
    host: async (listing: Listing, args: {}, context: { db: Database }): Promise<User> => {
      const { db } = context;
      const host = await db.users.findOne({ _id: listing.host });

      if (!host) {
        throw new Error("Could not find listing's host");
      }

      return host;
    }
  }
};
