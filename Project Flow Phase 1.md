**Production Order Tracking System with QR-Supported Station Workflow**

_Prepared for RasCorp•  August 5, 2026_

# **1. Production Workflow**

The system tracks each order through eight sequential stages, from intake to final delivery or return-to-sender, with every station required to log both a receiving and an outgoing time.

|**Step**|**Stage**|**Description**|
|---|---|---|
|**1**|**Order Intake**|Sales Agent records customer, car model, product type, order date, deadline, and priority.|
|**2**|**Cutting**|Cutting team logs receiving and outgoing.|
|**3**|**Sewing**|Sewing team logs receiving and outgoing.|
|**4**|**Embroidery**|Embroidery team logs receiving and outgoing.|
|**5**|**QC**|Quality control reviews, approves, or routes back for rework.|
|**6**|**Packaging**|Item packed for hand-off.|
|**7**|**Courier / Pick-up**|Item released to courier or customer pick-up.|
|**8**|**Delivered / Return to Sender**|Item status marked Delivered upon customer confirmation. If the client reports a defect, is unsatisfied, or finds the product lacking, the order is marked Return to Sender and routed back to the specific station responsible for correction.|

# **2. System Features**

The base system delivers the following fourteen features, plus an optional client-facing ordering portal.

|**#**|**Feature**|**Description**|
|---|---|---|
|1|**Order Intake**|Order ID, customer, car model, product type, order date, priority, and proposed duration captured at intake.|
|2|**Stations**|Cutting, Sewing, Embroidery, QC, Packaging, Courier/Pick-up — six tracked stages.|
|3|**QR-Supported Transitions**|Every move between stations requires a QR scan; no manual status entry.|
|4|**Receiving & Outgoing Log**|Each station logs a received time and an outgoing time — not one completion mark.|
|5|**Priority Flagging & Sequencing**|Set at intake as a priority number (P1, P2, P3…), not just yes/no — stations know which to work first when several are priority at once.|
|6|**QR Tagging**|Unique QR code generated per order at intake, printed on the job ticket/fabric tag, with the priority number printed alongside it if flagged.|
|7|**QC Rework Routing**|QC can send an item back to Cutting or Sewing; the rework loop is tracked as part of the order's timeline.|
|8|**Order Timeline View**|Full chronological view of an order's movement through every station, with timestamps and who updated each step.|
|9|**Proposed Duration & Overdue Detection**|Deadline flagging driven by the proposed duration set at intake.|
|10|**Complete Order Report**|Per-order report of every station's receive-to-out timestamps and total turnaround.|
|11|**Basic Role-Based Login**|Grouped login access (Production Staff, Supervisor, Management).|
|12|**Order Dashboard**|Live board of active orders, filterable by stage, priority, and status.|
|13|**Automated Backups**|Scheduled database backups pushed to off-site cloud storage.|
|14|**Delivery Outcome & Return Reason Logging**|Delivered orders record customer confirmation. Orders sent back are logged as Return to Sender with a reason — defect, customer dissatisfaction, or missing/lacking items — and routed to the responsible station for correction.|
